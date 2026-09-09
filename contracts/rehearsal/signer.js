/* A signing service for the browser test: the "wallet" in the page hands eth_sendTransaction here, and the matching key signs it for real on the local node. */
const http = require('http');
const C = require('./chain.js');
const who = (from) => Object.keys({ a: 1, b: 1, vault: 1 }).find((k) => C.addr(k).toLowerCase() === String(from).toLowerCase());
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const tx = JSON.parse(body); const k = who(tx.from);
      if (!k) throw new Error('no key for ' + tx.from);
      const { client } = C.wallet(k);
      const hash = await client.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined });
      console.log('signed', k, tx.to, (tx.data || '').slice(0, 10), hash);
      res.end(JSON.stringify({ hash }));
    } catch (e) { console.log('refused', e.shortMessage || e.message); res.statusCode = 400; res.end(JSON.stringify({ error: e.shortMessage || e.message })); }
  });
}).listen(3498, () => console.log('signer on 3498'));
