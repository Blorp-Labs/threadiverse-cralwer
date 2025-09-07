import z from 'zod'
import _ from 'lodash'
import { dateLessThanOneMonthAgo } from './utils/date';
import { BasicCrawler, Dataset, RequestQueue } from "crawlee";
import fs from 'node:fs/promises'
import path from 'node:path';

const MIN_MAU = 20;

function isSupportedSoftware(software: string) {
  switch (software.trim().toLowerCase()) {
    case "lemmy":
    case "piefed":
      return true;
    default:
      return false;
  }
}

function normalizeInstance(instance: string) {
  instance = instance.trim();
  if (!instance.startsWith("http")) {
    instance = `https://${instance}`
  }
  return instance.replace(/\/+$/, "");
}

const lemmySiteV3 = z.object({
  site_view: z.object({
    site: z.object({
      description: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
    }),
    local_site: z.object({
      registration_mode: z.string(),
      private_instance: z.boolean(),
    }),
    counts: z.object({
      users_active_month: z.number()
    })
  }),
});

const pieFedSiteV3 = lemmySiteV3;

const nodeInfoSchema = z.object({
  software: z.object({
    name: z.enum(["lemmy", "piefed"]),
    version: z.string(),
  }),
});

const federatedInstancesSchema = z.object({
  federated_instances: z.object({
    linked: z.array(z.object({
      domain: z.string(),
      software: z.string().optional(),
      published: z.string().optional(),
      updated: z.string().optional(),
    }))
  })
})

type Instance = {
  url: string,
  host: string,
  description?: string,
  icon?: string,
  software: "lemmy" | "piefed"
  registrationMode: string,
};

async function crawl() {
  const dataset = await Dataset.open();

  const requestQueue = await RequestQueue.open();

  const crawler = new BasicCrawler({
    requestQueue,
    maxConcurrency: 50,
    minConcurrency: 5,
    requestHandlerTimeoutSecs: 10,
    maxRequestRetries: 3,
    requestHandler: async ({ request, sendRequest }) => {
      async function get<S extends z.ZodObject>(url: string, schema: S) {
        const nodeInfoReq = await sendRequest({
          url,
          method: "GET"
        })
        return schema.parse(JSON.parse(nodeInfoReq.body))
      }

      const explore = async (res: z.infer<typeof federatedInstancesSchema>) => {
        await requestQueue.addRequests(
          res.federated_instances.linked.filter(linked => {
            const updated = linked.updated ?? linked.published;
            return linked.software && isSupportedSoftware(linked.software) && updated && dateLessThanOneMonthAgo(updated)
          }).map(linked => normalizeInstance(linked.domain))
        )
      }

      const instance = normalizeInstance(request.url);

      const host = new URL(instance).host;

      const nodeInfo = await get(
        `${instance}/nodeinfo/2.1`,
        nodeInfoSchema
      )

      switch (nodeInfo.software.name) {
        case "lemmy": {
          if (nodeInfo.software.version.startsWith("1.")) {
            // const federatedInstances = await get(`${instance}/api/v4/federated_instances`, federatedInstancesSchema)
            // explore(federatedInstances)
          } else {
            const federatedInstances = await get(`${instance}/api/v3/federated_instances`, federatedInstancesSchema)
            await explore(federatedInstances)
            const site = await get(`${instance}/api/v3/site`, lemmySiteV3)
            if (site.site_view.counts.users_active_month >= MIN_MAU && !site.site_view.local_site.private_instance) {
              await Dataset.pushData<Instance>({
                url: instance,
                host,
                description: site.site_view.site.description,
                icon: site.site_view.site.icon,
                software: "lemmy",
                registrationMode: site.site_view.local_site.registration_mode,
              })
            }
          }
          break;
        }
        case "piefed": {
          const federatedInstances = await get(`${instance}/api/v3/federated_instances`, federatedInstancesSchema)
          await explore(federatedInstances)
          const site = await get(`${instance}/api/v3/site`, pieFedSiteV3)
          if (site.site_view.counts.users_active_month >= MIN_MAU && !site.site_view.local_site.private_instance) {
            await Dataset.pushData<Instance>({
              url: instance,
              host,
              description: site.site_view.site.description,
              icon: site.site_view.site.icon,
              software: "piefed",
              registrationMode: site.site_view.local_site.registration_mode,
            })
          }
          break;
        }
      }
    },
  });

  const write = async () => {
    const items = (await dataset.getData()).items as Instance[];
    const sorted = _.sortBy(items, 'host')
    const outPath = path.join(process.cwd(), "public", "v1");
    await fs.mkdir(outPath, { recursive: true });
    await fs.writeFile(path.join(outPath, "instances.json"), JSON.stringify(sorted, null, 2));
    await fs.writeFile(path.join(outPath, "instances.min.json"), JSON.stringify(sorted));
  }

  const id2 = setInterval(() => {
    write();
  }, 10_000)

  const id1 = setTimeout(() => {
    clearInterval(id2)
    crawler.autoscaledPool.abort();
    console.log("STOPPING CRAWLER DUE TO TIMEOUT")
  }, 20 * 60 * 1000)

  await crawler.run([
    "https://lemmy.world",
    "https://lemmy.zip",
    "https://lemmy.ml",
    "https://piefed.world",
  ]);

  clearTimeout(id1)
  write();
}
crawl();
