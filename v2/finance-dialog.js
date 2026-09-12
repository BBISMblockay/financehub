/* Explicit finance decisions. Text-only content; Escape/cancel never confirms. */
(function () {
  'use strict';
  function ask({ title, message, label = 'Continue', reason = false, minLength = 1, confirmation = '' }) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'bcn-card';
      dialog.style.cssText = 'width:540px;max-width:calc(100vw - 32px);padding:20px;color:var(--bcn-ink);background:var(--bcn-panel);border:1px solid var(--bcn-border);border-radius:12px';
      const heading = document.createElement('h2'); heading.textContent = title;
      const description = document.createElement('p'); description.textContent = message; description.style.whiteSpace = 'pre-line';
      const form = document.createElement('form'); form.method = 'dialog';
      const input = document.createElement('textarea'); input.className = 'bcn-field';
      input.setAttribute('aria-label', 'Reason'); input.placeholder = 'Explain your decision';
      input.hidden = !reason; input.required = reason; input.minLength = minLength;
      const checkLabel = document.createElement('label'); checkLabel.style.cssText = 'display:block;margin:16px 0';
      const check = document.createElement('input'); check.type = 'checkbox'; check.required = !!confirmation;
      checkLabel.append(check, document.createTextNode(' ' + confirmation)); checkLabel.hidden = !confirmation;
      const status = document.createElement('div'); status.className = 'bcn-status bcn-status--neg'; status.hidden = true;
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'bcn-btn'; cancel.textContent = 'Cancel';
      const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'bcn-btn bcn-btn--primary'; submit.textContent = label;
      let result = null;
      const validate = () => { submit.disabled = (!!confirmation && !check.checked) || (reason && input.value.trim().length < minLength); };
      input.addEventListener('input', validate); check.addEventListener('change', validate);
      cancel.addEventListener('click', () => dialog.close());
      form.addEventListener('submit', (event) => {
        event.preventDefault(); validate();
        if (submit.disabled) { status.textContent = 'Confirm the decision and enter the required reason to continue.'; status.hidden = false; return; }
        result = reason ? input.value.trim() : true; dialog.close();
      });
      dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
      dialog.addEventListener('keydown', event => {if(event.key==='Escape')event.stopPropagation();});
      actions.append(cancel, submit); form.append(input, checkLabel, status, actions); dialog.append(heading, description, form);
      document.body.append(dialog); validate(); dialog.showModal(); (reason ? input : cancel).focus();
    });
  }
  window.SiloFinanceDialog = { ask };
})();
