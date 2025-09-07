import z from 'zod'
import { asyncQueue, AsyncQueuer } from '@tanstack/pacer'
import _ from 'lodash'
import chalk from 'chalk';
import { dateLessThanOneMonthAgo } from './utils/date';
import * as asciichart from "asciichart";
import { BasicCrawler } from "crawlee";

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

async function get<S extends z.ZodObject>(url: string, schema: S) {
  try {
    verboseLog(2, `GET ${url}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    const json = await res.json()
    return schema.parse(json)
  } catch (err) {
    // verboseLog(1, JSON.stringify(err))
    throw err;
  }
}

const discovered: {
  url: string,
  host: string,
  description?: string,
  icon?: string,
  software: "lemmy" | "piefed"
  registrationMode: string,
}[] = [];

const processQueueItem = _.memoize(async (instance: string): Promise<string | null> => {
  KNOWN.add(instance);
  try {
    instance = normalizeInstance(instance);

    const host = new URL(instance).host;

    const nodeInfo = await get(`${instance}/nodeinfo/2.1`, nodeInfoSchema)

    const explore = (res: z.infer<typeof federatedInstancesSchema>) => {
      for (const linked of res.federated_instances.linked) {
        const updated = linked.updated ?? linked.published;
        if (linked.software && isSupportedSoftware(linked.software) && updated && dateLessThanOneMonthAgo(updated)) {
          verboseLog(2, "Found: ", linked.domain)
          queue(normalizeInstance(linked.domain))
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
          // discovered.push({
          //   url: instance,
          //   host,
          //   description: site.site_view.site.description,
          //   icon: site.site_view.site.icon,
          //   software: "lemmy",
          //   registrationMode: site.site_view.local_site.registration_mode,
          // })
        }
        break;
      }
      case "piefed": {
        const federatedInstances = await get(`${instance}/api/v1/federated_instances`, federatedInstancesSchema)
        explore(federatedInstances)
        const site = await get(`${instance}/api/alpha/site`, pieFedSiteV3)
        // discovered.push({
        //   url: instance,
        //   host,
        //   description: site.site.description,
        //   icon: site.site.icon,
        //   software: "lemmy",
        //   registrationMode: site.site.registration_mode,
        // })
        break;
      }
    }
  } catch {
    return null;
  }
});

const progress: {
  known: number,
  visited: number,
}[] = [{
  known: 0,
  visited: 0,
}];

let i = 0;
function reportProgress() {
  progress[i % 100] = ({
    known: KNOWN.size,
    visited: discovered.length,
  })
  i++;

  const colors = [asciichart.blue, asciichart.green];

  const chart = asciichart.plot([progress.map(p => p.visited), progress.map(p => p.known - p.visited)], {
    height: 10,
    colors,
  });

  console.clear();
  console.log(chart);
}

const queue = asyncQueue(
  processQueueItem,
  {
    concurrency: 30,
    onSettled: _.debounce((_1, queue: AsyncQueuer<string>) => {
      if (queue.peekAllItems().length === 0) {
        process.exit(0)
      }
    }, 500)
  }
)

const FRAME_MS = 1000 / 30;

function frameLoop() {
  const start = Date.now();

  // do your “frame work” here
  update();

  const elapsed = Date.now() - start;
  setTimeout(frameLoop, Math.max(0, FRAME_MS - elapsed));
}

function update() {
  reportProgress();
}

frameLoop();

// const dataPath = path.join(__dirname, "data.json")
// fs.writeFile(dataPath, JSON.stringify(discovered, null, 2))

queue("https://lemmy.world");
queue("https://lemmy.zip");
