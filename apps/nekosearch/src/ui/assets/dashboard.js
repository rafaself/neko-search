const tokenFromLink = new URLSearchParams(window.location.hash.slice(1)).get(
  'token',
);
if (tokenFromLink) {
  sessionStorage.setItem('nekosearch-token', tokenFromLink);
  window.history.replaceState(null, '', window.location.pathname);
}
const token = sessionStorage.getItem('nekosearch-token');
const catalog = document.querySelector('#catalog');
const sourceCount = document.querySelector('#source-count');
const refresh = document.querySelector('#refresh');
const notice = document.querySelector('#notice');
const restart = document.querySelector('#restart');
const localForm = document.querySelector('#local-form');
const curatedForm = document.querySelector('#curated-form');
const curatedSelect = document.querySelector('#curated-source');
const install = document.querySelector('#install');
const importFolder = document.querySelector('#import');
const snapshotRow = document.querySelector('#snapshot-row');

let busy = false;
let catalogReadable = false;

const phases = {
  starting: 'Starting operation…',
  checking: 'Checking the upstream revision…',
  resolving: 'Resolving the source revision…',
  downloading: 'Downloading documentation…',
  indexing: 'Indexing documentation…',
  validating: 'Validating the snapshot…',
  installing: 'Installing the snapshot…',
  removing: 'Removing the snapshot…',
};

refresh.addEventListener('click', () => void refreshCatalog());
curatedForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void startJob({
    operation: 'install-curated',
    selector: curatedSelect.value,
  });
});
localForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = new FormData(localForm);
  void startJob({
    operation: 'import-directory',
    selector: fields.get('selector'),
    directory: fields.get('directory'),
  });
});

if (token) {
  void refreshCatalog();
} else {
  showNotice(
    'Open the dashboard using the link printed by NekoSearch.',
    'error',
  );
}

async function api(path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  const options = { headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? 'The dashboard request failed.');
  return data;
}

async function refreshCatalog() {
  setBusy(true);
  try {
    const warning = await loadCatalog();
    showNotice(warning, 'error');
  } catch (error) {
    catalogReadable = false;
    showNotice(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function loadCatalog() {
  const { readable, errors, entries, curatedSources } =
    await api('/api/catalog');
  catalogReadable = readable;
  sourceCount.textContent = `${entries.length} ${entries.length === 1 ? 'source' : 'sources'}`;
  catalog.replaceChildren(...entries.map(renderSnapshot));
  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty muted';
    empty.textContent = 'No snapshots available.';
    catalog.append(empty);
  }
  const available = curatedSources.filter(
    (selector) => !entries.some((entry) => entry.selector === selector),
  );
  curatedSelect.replaceChildren(
    ...available.map((selector) => new Option(selector, selector)),
  );
  if (available.length === 0)
    curatedSelect.add(new Option('All curated sources installed', ''));
  return readable ? '' : errors.join(' ') || 'The catalog could not be read.';
}

function renderSnapshot(entry) {
  const row = snapshotRow.content.cloneNode(true);
  row.querySelector('strong').textContent = entry.selector;
  const badge =
    entry.status === 'bundled'
      ? 'Bundled'
      : ({ tracked: 'Tracked', pinned: 'Pinned' }[entry.tracking] ??
        'Imported');
  row.querySelector('.badge').textContent = badge;
  row.querySelector('.snapshot-detail span').textContent =
    `${entry.documentCount} ${entry.documentCount === 1 ? 'document' : 'documents'}`;
  const revision = row.querySelector('code');
  revision.textContent =
    entry.revision.length > 13
      ? `${entry.revision.slice(0, 10)}…`
      : entry.revision;
  revision.title = entry.revision;
  const actions = row.querySelector('.snapshot-actions');
  if (entry.tracking === 'tracked') {
    actions.append(
      action('Check upstream', () =>
        startJob({ operation: 'check-upstream', selector: entry.selector }),
      ),
    );
    actions.append(
      action('Update', () =>
        startJob({
          operation: 'update',
          selector: entry.selector,
          snapshotKey: entry.snapshotKey,
        }),
      ),
    );
  }
  if (entry.status === 'installed') {
    actions.append(
      action(
        'Remove',
        () => {
          if (window.confirm(`Remove ${entry.selector} from the catalog?`)) {
            void startJob({
              operation: 'remove',
              selector: entry.selector,
              snapshotKey: entry.snapshotKey,
            });
          }
        },
        'danger',
      ),
    );
  }
  return row;
}

function action(label, handler, variation = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `secondary ${variation}`;
  button.textContent = label;
  button.addEventListener('click', () => void handler());
  return button;
}

async function startJob(input) {
  if (busy || !catalogReadable) return;
  setBusy(true);
  showNotice(phases.starting);
  try {
    let job = await api('/api/jobs', input);
    while (job.status.state === 'running') {
      showNotice(phases[job.status.phase] ?? 'Working…');
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      job = await api(`/api/jobs/${job.id}`);
    }
    if (job.status.state === 'succeeded') {
      const { result } = job.status;
      if (result.catalogChanged) restart.hidden = false;
      if (input.operation === 'import-directory') localForm.reset();
      showNotice([result.message, result.warning].filter(Boolean).join(' '));
    } else {
      showNotice(job.status.error, 'error');
    }
    if (input.operation !== 'check-upstream') {
      const warning = await loadCatalog();
      if (warning) showNotice(warning, 'error');
    }
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

function showNotice(message, kind = 'info') {
  if (notice.textContent !== message) notice.textContent = message;
  notice.hidden = !message;
  notice.dataset.kind = kind;
}

function setBusy(active) {
  busy = active;
  refresh.disabled = active;
  const disableActions = active || !catalogReadable;
  curatedSelect.disabled = disableActions || !curatedSelect.value;
  install.disabled = curatedSelect.disabled;
  importFolder.disabled = disableActions;
  for (const button of catalog.querySelectorAll('button'))
    button.disabled = disableActions;
}
