/**
 * Remote access configuration names used by the cloud HTTP proxy: `<scheme>[+<option>...]:<label>`,
 * e.g. `http:Node-RED`, `https:Router` or `http+mux:Grafana`.
 *
 * Options:
 * - `mux`: the device supports remote access multiplexing (thin-edge.io), so all connections of a
 *   session are carried over a single remote access websocket
 *
 * Keep in sync with the UI plugin (frontend/src/app/cloud-http-proxy/connection-name.ts).
 */
export interface ConnectionName {
  secure: boolean;
  multiplex: boolean;
  label: string;
}

const pattern = /^(https?)((?:\+[a-z0-9-]+)*):(.*)$/;

export function parseConnectionName(name: string | undefined): ConnectionName | undefined {
  const match = pattern.exec(name || "");
  if (!match) {
    return undefined;
  }
  const [, scheme, options, label] = match;
  const optionList = options.split("+").filter(Boolean);
  return {
    secure: scheme === "https",
    multiplex: optionList.includes("mux"),
    label,
  };
}
