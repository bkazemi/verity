/**
 * Puts a copy button on every block the page asks the holder to reproduce exactly. The
 * button is made here rather than written into the page, so a reader with no scripting is
 * never shown a control that does nothing: without this the block is still selectable text.
 *
 * Served as a file because these pages allow no inline scripts.
 */
export const copyScript = `for (const block of document.querySelectorAll('pre')) {
  const code = block.querySelector('code');

  if (!code) continue;

  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copy';
  button.setAttribute('aria-live', 'polite');

  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
    } catch {
      // No clipboard permission, or an insecure origin. Select it instead, which leaves
      // the holder one keystroke away rather than telling them it worked when it did not.
      // The label stays short so the button never grows over the line it sits on.
      const range = document.createRange();
      const selection = getSelection();

      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Selected';
    }

    setTimeout(() => (button.textContent = 'Copy'), 2000);
  });

  block.prepend(button);
}
`;
