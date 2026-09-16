const client = Verity.init({ backendUrl: '/api/verity' });
const message = document.getElementById('message');

async function action(work) {
  try {
    await work();
    await render();
  } catch {
    message.textContent = 'Request failed. Please try again.';
  }
}

document.getElementById('verify').onclick = () =>
  action(async () => {
    const result = await client.connect({ provider: 'github' });

    message.textContent = `Verification ${result.outcome}.`;
  });

async function render() {
  const response = await fetch('/api/verity/mine', { cache: 'no-store' });

  if (!response.ok) throw new Error('Sign in required');

  const connections = await response.json();
  const list = document.getElementById('connections');

  list.replaceChildren();

  for (const connection of connections) {
    const section = document.createElement('section');
    const title = document.createElement('h3');

    title.textContent = `${connection.external.handle}: ${connection.status} (${connection.visibility})`;
    section.append(title);

    const button = (label, work) => {
      const el = document.createElement('button');

      el.textContent = label;
      el.onclick = () => action(work);
      section.append(el);
    };

    if (connection.visibility === 'public') {
      const link = document.createElement('a');

      link.href = connection.evidenceUrl;
      link.textContent = 'Inspect evidence';
      section.append(link);
    }

    if (connection.status !== 'revoked') {
      button('Disconnect', () => client.disconnect(connection.id));
      const visibility = document.createElement('a');

      visibility.href = `/api/verity/visibility/${connection.id}`;
      visibility.textContent = 'Change visibility (authenticate with GitHub)';
      section.append(visibility);

      if (connection.visibility === 'unlisted') {
        button('Create / replace sharing link', async () => {
          const result = await client.issueShare(connection.id);

          message.replaceChildren(
            document.createTextNode(
              'Anyone with this link can view and forward it. Copy it now; it is shown only once: ',
            ),
          );

          const link = document.createElement('a');

          link.href = result.url;
          link.textContent = result.url;
          message.append(link);
        });

        button('Revoke sharing link', async () => {
          await client.revokeShare(connection.id);
          message.textContent = 'Sharing link revoked. The connection remains recorded.';
        });
      }
    }

    list.append(section);
  }
}

void action(async () => {});
