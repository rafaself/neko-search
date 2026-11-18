# MCP connection lifecycle

In the `2025-11-25` protocol revision, a client begins a connection with the `initialize` request. It supplies the protocol version it supports and its client capabilities. The server responds with the version and server capabilities it will use. If the peers cannot agree on a supported version, they should end the connection rather than exchange feature requests under mismatched rules.

After the response, the client sends the `notifications/initialized` notification. The peers can then use the capabilities negotiated for that connection. A client should not call a feature before initialization has completed.

The `ping` request lets either peer check that the other is responsive. Request cancellation and progress notifications can be used for work that takes longer than a short request. When a connection ends, the transport closes and the client should discard the negotiated session state.

This page describes the handshake-era lifecycle for the pinned protocol revision. Consult the [official lifecycle specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) when implementing a peer.
