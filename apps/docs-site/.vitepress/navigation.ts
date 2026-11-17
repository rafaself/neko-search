import type { DefaultTheme } from 'vitepress';

export const sidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Quick Start', link: '/getting-started/quick-start' },
      { text: 'Interactive Setup', link: '/getting-started/setup' },
    ],
  },
  {
    text: 'Guides',
    items: [
      { text: 'Documentation Sources', link: '/guides/documentation-sources' },
      { text: 'Snapshots', link: '/guides/snapshots' },
      { text: 'Custom Documentation', link: '/guides/custom-documentation' },
      { text: 'Updating & Removing', link: '/guides/updating' },
    ],
  },
  {
    text: 'CLI',
    items: [
      { text: 'Overview', link: '/cli/overview' },
      { text: 'Command Reference', link: '/cli/commands' },
    ],
  },
  {
    text: 'MCP',
    items: [
      { text: 'Overview', link: '/mcp/overview' },
      { text: 'Tool Reference', link: '/mcp/tools' },
      { text: 'Client Configuration', link: '/mcp/client-configuration' },
    ],
  },
  {
    text: 'Architecture',
    items: [
      { text: 'Overview', link: '/architecture/overview' },
      {
        text: 'Documentation Engine',
        link: '/architecture/documentation-engine',
      },
      { text: 'Retrieval', link: '/architecture/retrieval' },
    ],
  },
  {
    text: 'Development',
    items: [
      { text: 'Contributing', link: '/development/contributing' },
      { text: 'Development Setup', link: '/development/development-setup' },
    ],
  },
] satisfies DefaultTheme.SidebarItem[];
