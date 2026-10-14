// uso: pnpm hash-password   (lê a senha do stdin; imprime o valor para ADMIN_PASSWORD_HASH)
import { hashPassword } from "../apps/api/src/auth.ts";
let pw = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) pw += c;
pw = pw.replace(/\r?\n$/, "");
if (!pw) { console.error("senha vazia"); process.exit(1); }
console.log(hashPassword(pw));
