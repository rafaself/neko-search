---
layout: page
title: Documentation search for AI coding agents
description: Build local documentation snapshots and give AI coding agents accurate, structured access through MCP.
sidebar: false
outline: false
editLink: false
lastUpdated: false
---

<script setup>
import { withBase } from 'vitepress'
</script>

<div class="neko-home">
  <section class="neko-hero" aria-labelledby="hero-title">
    <div>
      <p class="neko-eyebrow">NekoSearch · Documentation infrastructure</p>
      <h1 id="hero-title">Documentation search for <em>AI coding agents.</em></h1>
      <p class="neko-lead">Build searchable documentation snapshots and expose them through MCP, giving AI coding agents accurate, structured access to the documentation they need.</p>
      <div class="neko-actions">
        <a class="neko-primary" :href="withBase('/getting-started/installation.html')">Get Started <span aria-hidden="true">&nbsp;→</span></a>
        <a class="neko-secondary" href="https://github.com/rafaself/neko-search">GitHub Repository <span aria-hidden="true">&nbsp;↗</span></a>
      </div>
    </div>
    <div class="neko-terminal" aria-label="NekoSearch installation commands">
      <div class="neko-terminal-bar"><i></i><i></i><i></i><span>terminal — getting started</span></div>
      <div class="neko-terminal-body">
        <p class="comment"># Install the CLI</p>
        <p><span class="prompt">$ </span><code>npm install --global nekosearch</code></p>
        <p>&nbsp;</p>
        <p class="comment"># Choose docs. Connect your agent.</p>
        <p><span class="prompt">$ </span><code>nekosearch setup</code></p>
        <p>&nbsp;</p>
        <p class="comment"># See your available snapshots</p>
        <p><span class="prompt">$ </span><code>nekosearch list</code></p>
      </div>
      <div class="neko-terminal-note">Your MCP client launches NekoSearch when it needs it.</div>
    </div>
  </section>

  <div class="neko-facts" aria-label="Product properties"><span>Local snapshots</span><span>Read-only serving</span><span>Explicit sources</span><span>No API key for retrieval</span></div>

  <section class="neko-section" aria-labelledby="features-title">
    <div class="neko-section-header">
      <div><p class="neko-eyebrow">Context, with provenance</p><h2 id="features-title">The right docs. In reach.</h2></div>
      <p>Keep documentation available to your agent, with exact source selectors and revisions attached to the results.</p>
    </div>
    <div class="neko-features">
      <article class="neko-feature"><span class="neko-number">01 / MCP</span><h3>Native to your agent</h3><p>Discover, search, and fetch documentation through three focused MCP tools over stdio.</p></article>
      <article class="neko-feature"><span class="neko-number">02 / CURATED</span><h3>Start with a trusted source</h3><p>Install optional NestJS 11 or 12 documentation from the official repository. A small MCP protocol reference is included.</p></article>
      <article class="neko-feature"><span class="neko-number">03 / INGESTION</span><h3>Bring your own documentation</h3><p>Build from local Markdown and MDX, ingest a public GitHub directory, or install a portable snapshot.</p></article>
      <article class="neko-feature"><span class="neko-number">04 / SNAPSHOTS</span><h3>Ready when the network isn't</h3><p>Search installed snapshots locally. Serving never downloads documentation or opens a network listener.</p></article>
      <article class="neko-feature"><span class="neko-number">05 / REFERENCES</span><h3>Follow the next useful link</h3><p>Fetch resolved internal references directly from the snapshot, including links to individual sections.</p></article>
      <article class="neko-feature"><span class="neko-number">06 / RETRIEVAL</span><h3>Choose the source explicitly</h3><p>Search up to five exact selectors together, with separate result groups and a shared result limit.</p></article>
      <article class="neko-feature"><span class="neko-number">07</span><h3>Fits your coding workflow</h3><p>Configure supported clients such as Codex, Claude Code, Cursor, and more through interactive setup.</p></article>
    </div>
  </section>

  <section class="neko-section" aria-labelledby="flow-title">
    <div class="neko-section-header">
      <div><p class="neko-eyebrow">How it works</p><h2 id="flow-title">From source to useful context.</h2></div>
      <p>Build and install first. Search and fetch from a local, validated snapshot when your agent connects.</p>
    </div>
    <ol class="neko-flow" aria-label="Documentation processing flow">
      <li><span class="step">01</span><strong>Documentation Sources</strong><small>Markdown &amp; MDX</small></li>
      <li><span class="step">02</span><strong>Ingestion &amp; Processing</strong><small>Parse · normalize · chunk</small></li>
      <li><span class="step">03</span><strong>Documentation Snapshots</strong><small>Corpus · index · manifest</small></li>
      <li><span class="step">04</span><strong>Retrieval Engine</strong><small>Search · fetch · follow</small></li>
      <li><span class="step">05</span><strong>MCP Server</strong><small>Read-only stdio</small></li>
      <li><span class="step">06</span><strong>AI Coding Agents</strong><small>Structured context</small></li>
    </ol>
    <p class="neko-caption">Each result carries its source revision. Fetches stay scoped to one selected snapshot.</p>
  </section>

  <section class="neko-section neko-quickstart" aria-labelledby="quickstart-title">
    <div>
      <p class="neko-eyebrow">Your first snapshot</p>
      <h2 id="quickstart-title">Your docs. Your agent.<br>A few commands away.</h2>
      <p>Point NekoSearch at a directory of Markdown or MDX files. Install it locally, then let your agent discover it with <code>list_docs</code>.</p>
      <a class="neko-text-link" :href="withBase('/getting-started/quick-start.html')">Follow the quick start →</a>
    </div>
    <div class="vp-doc">

```sh
npm install --global nekosearch

# In a project with a docs directory
nekosearch add --dir ./docs --id my-api@1

# Review and confirm your client registration
nekosearch setup
nekosearch list
```

</div>
</section>
</div>
