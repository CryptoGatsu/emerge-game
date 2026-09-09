/*
 * A browser wallet for the rehearsal that really signs: reads go straight to
 * the node, and every eth_sendTransaction is handed to signer.js, which signs
 * it with the player's key and broadcasts it. Injected into the page before
 * the app loads, in place of a wallet extension.
 */
module.exports = (address, chainId = 4663, rpc = 'http://127.0.0.1:8545', signer = 'http://127.0.0.1:3498/send') => `
  window.__sent = [];
  const address = ${JSON.stringify(address)};
  let id = 1;
  const rpc = async (method, params) => { const r = await fetch(${JSON.stringify(rpc)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) }); const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return '0x${chainId.toString(16)}';
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'personal_sign') throw Object.assign(new Error('unsupported: personal_sign'), { code: 4200 });
      if (method === 'eth_sendTransaction') {
        window.__sent.push(params[0]);
        const r = await fetch(${JSON.stringify(signer)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params[0]) });
        const j = await r.json(); if (j.error) throw new Error(j.error); return j.hash;
      }
      return rpc(method, params);
    },
    on: () => {}, removeListener: () => {},
  };
`;
