import { readFileSync } from "fs";
import * as mc from "@intlify/message-compiler";

const compile = mc.baseCompile || mc.compile;
function walk(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + "." + k : k;
    if (typeof v === "string") out.push([key, v]);
    else walk(v, key, out);
  }
}
for (const f of ["src/i18n/zh-CN.json", "src/i18n/en.json"]) {
  const msgs = [];
  walk(JSON.parse(readFileSync(f, "utf8")), "", msgs);
  for (const [key, m] of msgs) {
    try {
      const errs = [];
      compile(m, { onError(e) { errs.push(e); }, onASTCreated() {} });
      if (errs.length) console.log("AST-ERR", f, key, JSON.stringify(m), errs.map(e=>e.message).join(";"));
    } catch (e) {
      console.log("THROW", f, key, JSON.stringify(m), "=>", e.message);
    }
  }
}
console.log("done");
