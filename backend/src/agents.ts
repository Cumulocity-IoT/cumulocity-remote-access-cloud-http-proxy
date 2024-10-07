import Agent from "agentkeepalive";
import { HttpsAgent } from "agentkeepalive";

const agentOptions: Agent.HttpOptions = {
  timeout: 60_000, // active socket keepalive for 60 seconds
  freeSocketTimeout: 30_000, // free socket keepalive for 30 seconds
};
export const agents = {
  http: new Agent({
    ...agentOptions,
  }),
  https: new HttpsAgent({
    ...agentOptions,
  }),
};