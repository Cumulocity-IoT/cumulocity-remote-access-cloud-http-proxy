import * as dotenv from "dotenv";
import { Logger, createLogger, format, transports } from "winston";
import { CronJob } from "cron";
import { statistics } from "./statistics";
import Server, { createProxyServer } from "http-proxy";
import { ConnectionDetails } from "./connection-details";
import { RCAConnectionServer } from "./rca-connection-server";
import express from "express";
import { HeaderAdjustment } from "./header-adjustment";
import { RCAServerStore } from "./rca-server-store";
import Agent from "agentkeepalive";
import { HttpsAgent } from "agentkeepalive";
import * as http from "http";

dotenv.config();

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
  defaultMeta: { statistics },
});

const serverStore = new RCAServerStore(logger);
const agentOptions: Agent.HttpOptions = {
  timeout: 60_000, // active socket keepalive for 60 seconds
  freeSocketTimeout: 30_000, // free socket keepalive for 30 seconds
}
const agents = {
  http: new Agent({
    ...agentOptions
  }),
  https: new HttpsAgent({
    ...agentOptions
  })
}

logger.debug(JSON.stringify(process.env));
const app = express();

app.get("/health", (req, res) => {
  res.status(200).json({
    memory: process.memoryUsage(),
    agent: agents.http.getCurrentStatus(),
    secureAgent: agents.http.getCurrentStatus(),
  });
});

app.use((req, res, next) => {
  if (req.headers.authorization || req.headers.cookie?.includes('authorization')) {
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="My Realm"')
  res.status(401).send();
});

async function getTarget(
  req: express.Request<
    {
      cloudProxyDeviceId: string;
    } & {
      cloudProxyConfigId: string;
    }
  >,
  requestLogger: Logger,
  secure?: boolean
) {
  let details: ConnectionDetails;
  try {
    details = new ConnectionDetails(req, requestLogger);
    await details.extractDetails();
  } catch (e) {
    requestLogger.error("Failed to retrieve details", {
      e,
      errorMessage: e.errorMessage,
      headers: req.headers,
    });
    throw e;
  }

  statistics.totalNumberOfRequests++;
  let rcaConnServer: RCAConnectionServer;
  try {
    rcaConnServer = await serverStore.getServer(details, requestLogger);
  } catch (e) {
    requestLogger.error("Failed to get RCA Server.", { e });
    throw e;
  }

  HeaderAdjustment.adjust(req.headers, details);

  const protocol = secure ? "https" : "http";

  return `${protocol}://localhost:${rcaConnServer.port}`;
}

function hostRewrite(req: express.Request<any>, secure: boolean) {
  let host = req.headers.host;
  if (req.headers["x-forwarded-host"]) {
    host = req.headers["x-forwarded-host"] as string;
  }
  return `${host}/service/cloud-http-proxy${secure ? "/s" : ""}/${
    req.params.cloudProxyDeviceId
  }/${req.params.cloudProxyConfigId}`;
}

function getRewriteOptions(
  req: express.Request<any>,
  secure?: boolean,
  hasCustomHost?: boolean
): Server.ServerOptions {
  const { "x-forwarded-host": forwardedHost } = req.headers;
  return {
    autoRewrite: false,
    hostRewrite: hostRewrite(req, secure),
    changeOrigin: !hasCustomHost,
    protocolRewrite: (req.headers["x-forwarded-proto"] as string) || "http",
    cookieDomainRewrite:
        typeof forwardedHost === "string" ? `.${forwardedHost.replace(/:.*$/, '')}` : undefined,
    cookiePathRewrite: `/service/cloud-http-proxy${secure ? '/s' : ''}/${req.params.cloudProxyDeviceId}/${req.params.cloudProxyConfigId}/`,
  };
}

function hasCustomHostHeader(req: express.Request, deviceId: string, configId: string) {
  const headerToLookoutFor = `rca-http-header-host-${deviceId}-${configId}`;
  return !!req.headers[headerToLookoutFor];
}

function prefixCookiesToBeSet(proxy: Server<http.IncomingMessage, http.ServerResponse<http.IncomingMessage>>) {
  proxy.on('proxyRes', (response) => {
    const cookiesToSet = response.headers["set-cookie"];
    if (!cookiesToSet?.length) {
      return;
    }

    const adjustedCookies = cookiesToSet.map((cookie: string) => {
      return `cloud-http-proxy-${cookie}`;
    });

    response.headers["set-cookie"] = adjustedCookies;
  });
}

app.use("/s/:cloudProxyDeviceId/:cloudProxyConfigId/", async (req, res) => {
  const requestLogger = logger.child({
    method: req.method,
    url: req.url,
    params: req.params,
  });

  try {
    const hasCustomHost = hasCustomHostHeader(req, req.params.cloudProxyDeviceId, req.params.cloudProxyConfigId);
    const target = await getTarget(req, requestLogger, true);
    const rewriteOptions = getRewriteOptions(req, true, hasCustomHost);
    const proxy = createProxyServer({
      target,
      agent: agents.https,
      secure: false,
      ...rewriteOptions,
    });

    if (req.headers.upgrade) {
      proxy.ws(req, req.socket, req.headers, undefined, (e) => {
        requestLogger.error("Error while proxying WS", { error: e });
        proxy.ws(req, req.socket, req.headers);
      });
      return;
    }

    prefixCookiesToBeSet(proxy);

    proxy.web(
      req,
      res,
      {
        // required as otherwise connection will be closed.
        headers: { connection: "keep-alive" },
      },
      (e) => {
        requestLogger.error("Error while proxying", { error: e });
        // res.sendStatus(500);
        proxy.web(req, res);
      }
    );
  } catch (e) {
    requestLogger.error("catch block", { error: e });
    res.sendStatus(500);
    return;
  }
});

app.use("/:cloudProxyDeviceId/:cloudProxyConfigId/", async (req, res) => {
  const requestLogger = logger.child({
    method: req.method,
    url: req.url,
    params: req.params,
  });

  try {
    const hasCustomHost = hasCustomHostHeader(req, req.params.cloudProxyDeviceId, req.params.cloudProxyConfigId);
    const target = await getTarget(req, requestLogger);
    const rewriteOptions = getRewriteOptions(req, true, hasCustomHost);
    const proxy = createProxyServer({
      target,
      agent: agents.http,
      ...rewriteOptions,
    });

    if (req.headers.upgrade) {
      proxy.ws(req, req.socket, req.headers, undefined, (e) => {
        requestLogger.error("Error while proxying WS", { error: e });
        proxy.ws(req, req.socket, req.headers);
      });
      return;
    }

    prefixCookiesToBeSet(proxy);

    proxy.web(
      req,
      res,
      {
        // required as otherwise connection will be closed.
        headers: { connection: "keep-alive" },
      },
      (e) => {
        requestLogger.error("Error while proxying", { error: e });
        // res.sendStatus(500);
        proxy.web(req, res);
      }
    );
  } catch (e) {
    requestLogger.error("catch block", { error: e });
    res.sendStatus(500);
    return;
  }
});

logger.info(`start listening on port ${process.env.SERVER_PORT}`);
const server = app.listen(process.env.SERVER_PORT);

// disable timeouts as otherwise websocket connections are closed after ~60-90 seconds
server.headersTimeout = 0;
server.requestTimeout = 0;

if (!process.env.NO_STATISTICS) {
  CronJob.from({
    cronTime: "0 * * * * *",
    onTick: () => {
      logger.info("Statistics", {
        memory: process.memoryUsage(),
        agent: agents.http.getCurrentStatus(),
        secureAgent: agents.https.getCurrentStatus(),
      });
    },
    start: true,
  });
}

