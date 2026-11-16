// Turn the object's files into loadable ES modules: strip TypeScript types,
// then rewrite each import to the URL of the module it names. The rules match
// the native loader in pdo/src/engine.rs.

import { transform } from "sucrase";
import { init as lexerInit, parse } from "es-module-lexer";

export const TEXT_MODULE_EXTS = ["html", "txt", "sql", "css", "md", "svg"];

const CLOUDFLARE_WORKERS = `
export const DurableObject = globalThis.__pdo.DurableObject;
export const WorkerEntrypoint = globalThis.__pdo.WorkerEntrypoint;
export const RpcTarget = globalThis.__pdo.RpcTarget;
export const env = globalThis.__pdo.env;
export default { DurableObject, WorkerEntrypoint, RpcTarget, env };
`;

export type ToUrl = (code: string, name: string) => string;

function find(files: Map<string, Uint8Array>, path: string): string | null {
  const candidates = [path, `${path}.ts`, `${path}.js`, `${path}/index.ts`, `${path}/index.js`];
  if (path.endsWith(".js")) candidates.push(path.slice(0, -3) + ".ts");
  return candidates.find((c) => files.has(c)) ?? null;
}

function resolvePath(from: string, spec: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Link the module graph rooted at `entry` and return the entry module's URL. */
export async function link(files: Map<string, Uint8Array>, entry: string, toUrl: ToUrl): Promise<string> {
  await lexerInit;
  const done = new Map<string, string>();
  const stack: string[] = [];
  let cfUrl: string | null = null;
  const dec = new TextDecoder("utf-8", { fatal: true });

  const load = (path: string): string => {
    const cached = done.get(path);
    if (cached) return cached;
    if (stack.includes(path)) {
      throw new Error(`import cycle (${[...stack, path].join(" -> ")}): the browser runtime cannot load cyclic imports yet`);
    }
    stack.push(path);
    let text: string;
    try {
      text = dec.decode(files.get(path)!);
    } catch {
      throw new Error(`${path} is not UTF-8 text, so it cannot be imported`);
    }
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
    let js: string;
    if (TEXT_MODULE_EXTS.includes(ext)) js = `export default ${JSON.stringify(text)};\n`;
    else if (ext === "json") js = `export default ${text};\n`;
    else {
      js = /^(ts|mts|tsx)$/.test(ext)
        ? transform(text, { transforms: ext === "tsx" ? ["typescript", "jsx"] : ["typescript"], disableESTransforms: true, filePath: path }).code
        : text;
      const [imports] = parse(js, path);
      // Rewrite from the end so earlier positions stay valid.
      for (const im of [...(imports as any[])].reverse()) {
        // Skip import.meta and dynamic imports whose argument is not a string literal.
        if ((im.type !== "static" && im.type !== "dynamic") || typeof im.specifier !== "string") continue;
        const spec: string = im.specifier;
        let url: string;
        if (spec.startsWith("cloudflare:")) {
          if (spec !== "cloudflare:workers") throw new Error(`${spec} is not available in pdo v0`);
          url = cfUrl ??= toUrl(CLOUDFLARE_WORKERS, "cloudflare:workers");
        } else if (spec.startsWith("./") || spec.startsWith("../")) {
          const target = resolvePath(path, spec);
          const found = find(files, target);
          if (!found) throw new Error(`module not found in object: ${target} (imported by ${path})`);
          url = load(found);
        } else {
          throw new Error(`cannot import ${JSON.stringify(spec)}: pdo v0 loads only files inside the object (relative imports) and cloudflare:workers; vendor the package into the object`);
        }
        // A static specifier's range excludes its quotes; a dynamic one's includes them.
        js = js.slice(0, im.start) + (im.type === "dynamic" ? JSON.stringify(url) : url) + js.slice(im.end);
      }
    }
    stack.pop();
    const url = toUrl(`${js}\n//# sourceURL=pdo:///${path}`, path);
    done.set(path, url);
    return url;
  };

  if (!files.has(entry)) throw new Error(`entry file ${entry} is not in this check-in`);
  return load(entry);
}
