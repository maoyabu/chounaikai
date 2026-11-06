(() => {
  const editor = document.getElementById('faq-answer-editor');
  if (!editor) return;
  const form = editor.closest('form');
  const source = form.elements.answer;
  const tools = form.querySelector('.faq-editor-tools');
  source.hidden = true;
  source.required = false;
  editor.hidden = false;
  tools.hidden = false;
  form.elements.answerFormat.value = 'html';
  const sync = () => {
    source.value = editor.innerHTML;
    const empty = !editor.textContent.replace(/\u00a0/g, ' ').trim();
    editor.setAttribute('aria-invalid', String(empty || source.value.length > 10000));
    return !empty && source.value.length <= 10000;
  };
  editor.addEventListener('input', sync);
  // Keep pasted content to plain text; formatting is applied with the toolbar.
  editor.addEventListener('paste', event => {
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    sync();
  });
  let selection;
  document.addEventListener('selectionchange', () => {
    const current = window.getSelection();
    if (current.rangeCount && editor.contains(current.anchorNode) && editor.contains(current.focusNode)) selection = current.getRangeAt(0).cloneRange();
  });
  const restore = () => {
    editor.focus();
    if (selection) {
      const current = window.getSelection();
      current.removeAllRanges();
      current.addRange(selection);
    }
  };
  tools.querySelectorAll('[data-command]').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      restore();
      const command = button.dataset.command;
      let value = null;
      if (command === 'createLink') {
        value = window.prompt('リンク先のURL（https://、http://、mailto:）を入力してください。');
        if (!value) return;
        value = value.trim();
        try {
          if (!['https:', 'http:', 'mailto:'].includes(new URL(value).protocol)) throw new Error();
        } catch { window.alert('有効なURLを入力してください。'); return; }
        restore();
      }
      document.execCommand(command, false, value);
      sync();
    });
  });
  tools.querySelector('[data-block]').addEventListener('change', event => {
    restore();
    document.execCommand('formatBlock', false, event.target.value);
    sync();
  });
  form.addEventListener('submit', event => {
    if (sync()) return;
    event.preventDefault();
    window.alert('回答を入力してください。HTMLを含め10,000文字まで保存できます。');
    editor.focus();
  });
})();
