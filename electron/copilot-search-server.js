'use strict'
const http = require('node:http')
const { randomBytes } = require('node:crypto')

// A read-only MCP endpoint, owned by this app process and this vault session.
async function startSearchServer (search) {
  const token = randomBytes(32).toString('hex')
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { res.writeHead(403).end(); return }
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405).end(); return }
    let body = ''
    try {
      for await (const chunk of req) {
        body += chunk
        if (body.length > 32768) { res.writeHead(413).end(); return }
      }
      const call = JSON.parse(body)
      if (call.id == null) { res.writeHead(202).end(); return }
      let result
      if (call.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tulip', version: '1.0.0' } }
      else if (call.method === 'ping') result = {}
      else if (call.method === 'tools/list') result = { tools: [{ name: 'search', description: 'Search Tulip notes and extracted PDF text, ranked by relevance. Supports tag:, path:, type:, prop: and quoted phrases. Does not edit notes.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['query'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false } }] }
      else if (call.method === 'tools/call' && call.params?.name === 'search') {
        const query = call.params.arguments?.query
        if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('Use a search query of 1–2000 characters.')
        try { result = { content: [{ type: 'text', text: JSON.stringify(await search(query)) }] } }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] } }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found' } })); return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
    } catch { if (!res.headersSent) res.writeHead(400); res.end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)) })
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start Tulip search.')
  return { config: { type: 'remote', url: `http://127.0.0.1:${address.port}/mcp`, oauth: false, headers: { Authorization: `Bearer ${token}` } }, close: () => server.close() }
}
module.exports = { startSearchServer }
