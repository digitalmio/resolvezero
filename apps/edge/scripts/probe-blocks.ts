import { encode, decode } from "dns-packet";
import { rawClient } from "@resolvezero/db/client";
const db = rawClient();
const P = "55eee5e7-b98f-4091-b080-3def0ab477b9";
const { doh_token } = (await db`SELECT doh_token FROM profiles WHERE id = ${P} LIMIT 1`)[0];
await db.end();
const probe = async (name: string) => {
  const q = encode({ id: 1, type: "query", flags: 0x0100, questions: [{ name, type: "A" }] });
  const dns = Buffer.from(q).toString("base64url");
  const res = await fetch(`https://resolvezero-edge.fly.dev/v1/${P}/${doh_token}?dns=${dns}`);
  const body = new Uint8Array(await res.arrayBuffer());
  let rcode = "?";
  try {
    const p: any = decode(Buffer.from(body));
    rcode = p.flags & 15;
  } catch {}
  return `${name} → status=${res.status} rcode=${rcode}`;
};
console.log(await probe("ads.adguard.com"));        // AdGuard list
console.log(await probe("0--0.winluckycloud.buzz")); // hagezi scam
console.log(await probe("clodshoporder.com"));       // hagezi fake-shop
console.log(await probe("github.com"));              // must stay forward
console.log(await probe("news.ycombinator.com"));    // must stay forward
process.exit(0);
