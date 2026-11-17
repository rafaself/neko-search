import { defineComponent, h } from 'vue';
import { useData, withBase, type Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { sidebar } from '../navigation';
import './custom.css';

const Breadcrumbs = defineComponent({
  setup() {
    const { page } = useData();
    return () => {
      if (page.value.relativePath === 'index.md') return null;
      const path = `/${page.value.relativePath.replace(/\.md$/u, '')}`;
      const group = sidebar.find(({ items }) =>
        items.some(({ link }) => link === path),
      );
      if (!group) return null;
      const current = group.items.find(({ link }) => link === path);
      return h(
        'nav',
        { class: 'neko-breadcrumbs', 'aria-label': 'Breadcrumb' },
        [
          h('a', { href: withBase('/') }, 'Home'),
          h('span', { 'aria-hidden': 'true' }, '/'),
          h(
            'a',
            {
              href: withBase(
                group.items[0]!.link === '/'
                  ? '/'
                  : `${group.items[0]!.link}.html`,
              ),
            },
            group.text,
          ),
          h('span', { 'aria-hidden': 'true' }, '/'),
          h('span', { 'aria-current': 'page' }, current?.text),
        ],
      );
    };
  },
});

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, { 'doc-before': () => h(Breadcrumbs) }),
} satisfies Theme;
