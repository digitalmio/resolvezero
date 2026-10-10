// unauthorized-source probe: query our own UDP 53 from the machine itself
// (machine IP is not whitelisted → expect REFUSED, rcode 5)
const q = new Uint8Array([
  0, 7, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  4, 112, 114, 111, 98, // "prob"
  1, 108, 2, 108, 110, // "l.ln" — name shape irrelevant for rcode test
  0, 0, 1, 0, 1,
]);
const s = await Bun.udpSocket({
  hostname: "0.0.0.0",
  port: 0,
  socket: {
    data(_s, d) {
      console.log("reply bytes:", d.length, "rcode:", d[3] & 15);
      process.exit(0);
    },
    error() {
      console.log("socket error");
      process.exit(1);
    },
  },
} as never);
s.send(q, 53, "fly-global-services");
await Bun.sleep(2000);
console.log("no reply");
process.exit(1);
