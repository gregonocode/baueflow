// O runtime de produção resolve estes imports pelo Next. No teste, usamos o
// TypeScript já instalado no projeto, sem adicionar bundler/framework de teste.
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = new URL("../", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    let candidate;
    if (specifier.startsWith("@/")) candidate = new URL(`${specifier.slice(2)}.ts`, root);
    else if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (candidate && existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith(".ts")) {
      const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
