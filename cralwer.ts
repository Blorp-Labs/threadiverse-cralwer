import z from 'zod'
import _ from 'lodash'
import chalk from 'chalk';
import { dateLessThanOneMonthAgo } from './utils/date';
import { BasicCrawler, Dataset, RequestQueue } from "crawlee";
import { BaseHttpClient, Log } from "@crawlee/core";
import fs from 'node:fs/promises'

const VERBOSE_LEVEL = 0;
const KNOWN = new Set<string>;

function isSupportedSoftware(software: string) {
  switch (software.trim().toLowerCase()) {
    case "lemmy":
    case "piefed":
      return true;
    default:
      return false;
  }
}

function verboseLog(level: number, ...text: string[]) {
  if (VERBOSE_LEVEL >= level) {
    console.log(chalk.gray(text.join(" ")));
  }
}

function normalizeInstance(instance: string) {
  instance = instance.trim();
  if (!instance.startsWith("http")) {
    instance = `https://${instance}`
  }
  return instance;
}

const lemmySiteV3 = z.object({
  site_view: z.object({
    site: z.object({
      description: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
    }),
    local_site: z.object({
      registration_mode: z.string(),
    })
  }),
});

const pieFedSiteV3 = z.object({
  site: z.object({
    description: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    registration_mode: z.string(),
  }),
});

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

  const processQueueItem = async (
    instance: string,
    sendRequest: BaseHttpClient['sendRequest'],
    log: Log
  ) => {
    KNOWN.add(instance);

    async function get<S extends z.ZodObject>(url: string, schema: S) {
      const nodeInfoReq = await sendRequest({
        url,
        method: "GET"
      })
      return schema.parse(JSON.parse(nodeInfoReq.body))
    }

    try {
      instance = normalizeInstance(instance);

      const host = new URL(instance).host;

      const nodeInfo = await get(
        `${instance}/nodeinfo/2.1`,
        nodeInfoSchema
      )

      const explore = (res: z.infer<typeof federatedInstancesSchema>) => {
        for (const linked of res.federated_instances.linked) {
          const updated = linked.updated ?? linked.published;
          if (linked.software && isSupportedSoftware(linked.software) && updated && dateLessThanOneMonthAgo(updated)) {
            verboseLog(2, "Found: ", linked.domain)
            requestQueue.addRequests([normalizeInstance(linked.domain)])
          }
        }
      }

      switch (nodeInfo.software.name) {
        case "lemmy": {
          if (nodeInfo.software.version.startsWith("1.")) {
            // const federatedInstances = await get(`${instance}/api/v4/federated_instances`, federatedInstancesSchema)
            // explore(federatedInstances)
          } else {
            const federatedInstances = await get(`${instance}/api/v3/federated_instances`, federatedInstancesSchema)
            explore(federatedInstances)
            const site = await get(`${instance}/api/v3/site`, lemmySiteV3)
            Dataset.pushData({
              url: instance,
              host,
              description: site.site_view.site.description,
              icon: site.site_view.site.icon,
              software: "lemmy",
              registrationMode: site.site_view.local_site.registration_mode,
            })
          }
          break;
        }
        case "piefed": {
          const federatedInstances = await get(`${instance}/api/v1/federated_instances`, federatedInstancesSchema)
          explore(federatedInstances)
          const site = await get(`${instance}/api/alpha/site`, pieFedSiteV3)
          Dataset.pushData({
            url: instance,
            host,
            description: site.site.description,
            icon: site.site.icon,
            software: "lemmy",
            registrationMode: site.site.registration_mode,
          })
          break;
        }
      }
    } catch { }
  };

  const crawler = new BasicCrawler({
    requestQueue,
    maxConcurrency: 50,
    minConcurrency: 5,
    requestHandlerTimeoutSecs: 10_000,
    // limit per host:
    // use RequestQueue with same hostname keys or run multiple crawlers per host
    requestHandler: async ({ request, log, sendRequest }) => {
      await processQueueItem(request.url, sendRequest, log)
    },
  });

  const id1 = setTimeout(() => {
    crawler.autoscaledPool.abort();
  }, 20 * 60 * 1000)

  const write = async () => {
    const { items } = await dataset.getData();
    await fs.writeFile("all-discovered.json", JSON.stringify(items, null, 2));
  }

  const id2 = setInterval(() => {
    write();
  }, 10_000)

  await crawler.run([
    "https://lemmy.world",
    "https://lemmy.zip",
  ]);

  clearTimeout(id1)
  clearInterval(id2)
  write();
}
crawl();
