# MCP transports

The protocol message model is independent of the transport that carries it. Each transport must preserve message boundaries and deliver client and server messages to the correct peer.

## Standard input and output

The stdio transport is intended for a client that starts a server as a local process. The client writes protocol messages to the server's standard input, and the server writes protocol messages to standard output. Standard output is reserved for protocol traffic; diagnostic logs belong on standard error. A stdio server should not start an unrelated network listener.

## Streamable HTTP

Streamable HTTP connects a client to a server over HTTP. The client sends JSON-RPC messages with HTTP requests, and the server can return a JSON response or stream protocol events where the specification allows it. A server using HTTP must apply the specification's transport and authorization requirements; stdio rules do not replace those controls.

The versioned transport details are in the [2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
