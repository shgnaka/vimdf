/** Native modal dialogs own input, composition, cancellation and focus. */
export function vaultDialog(title: string, fields: string[], description = "") {
  const caller = document.activeElement;
  const control = new AbortController();
  const dialog = document.createElement("dialog"); dialog.className = "password-dialog";
  dialog.setAttribute("aria-label", title);
  const form = document.createElement("form"), heading = document.createElement("h2"); heading.textContent = title;
  // Restore clears authenticated inputs before confirmation. Validation lives
  // at the operation boundary, rather than blocking its confirmation submit.
  form.noValidate = true;
  form.append(heading);
  if (description) { const p = document.createElement("p"); p.textContent = description; form.append(p); }
  const inputs = new Map<string, HTMLInputElement>();
  for (const field of fields) {
    const label = document.createElement("label"), input = document.createElement("input");
    input.type = "password"; input.autocomplete = "off"; input.required = true; input.setAttribute("aria-label", field);
    label.append(document.createTextNode(field + " "), input); form.append(label); inputs.set(field, input);
  }
  if (fields.length) {
    const label = document.createElement("label"), show = document.createElement("input"); show.type = "checkbox";
    label.append(show, document.createTextNode(" Show master password")); form.append(label);
    show.addEventListener("change", () => { for (const input of inputs.values()) input.type = show.checked ? "text" : "password"; });
  }
  const alert = document.createElement("p"); alert.setAttribute("role", "alert"); form.append(alert);
  const actions = document.createElement("div"); actions.className = "password-actions"; form.append(actions);
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; actions.append(cancel);
  let busy = false, submitAction: (() => Promise<void>) | undefined;
  const clear = () => { for (const input of inputs.values()) input.value = ""; };
  const close = () => {
    if (control.signal.aborted) return;
    control.abort(); clear(); dialog.close(); dialog.remove();
    if (caller instanceof HTMLElement && caller.isConnected) caller.focus();
  };
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", event => {
    if (event.isComposing && (event.key === "Enter" || event.key === "Escape")) event.preventDefault();
    event.stopPropagation();
  });
  const run = async (action: () => Promise<void>) => {
    if (busy || control.signal.aborted) return;
    busy = true; alert.textContent = "";
    try { await action(); }
    catch (e) {
      if (!control.signal.aborted) {
        alert.textContent = e instanceof Error ? e.message : "Unable to complete password operation";
        clear(); inputs.values().next().value?.focus();
      }
    } finally { busy = false; }
  };
  form.addEventListener("submit", event => { event.preventDefault(); if (submitAction) void run(submitAction); });
  dialog.append(form); document.body.append(dialog); dialog.showModal();
  (inputs.values().next().value ?? cancel).focus();
  return { dialog, form, alert, signal: control.signal, inputs, close, clear,
    button(text: string, action: () => Promise<void>, submit = true): HTMLButtonElement {
      const button = document.createElement("button"); button.textContent = text; button.type = submit ? "submit" : "button";
      if (submit) submitAction = action; else button.addEventListener("click", () => { void run(action); });
      actions.append(button); return button;
    },
  };
}

export function downloadVault(output: { text: string; mimeType: string; filename: string }): void {
  let url: string | undefined;
  const link = document.createElement("a");
  try {
    url = URL.createObjectURL(new Blob([output.text], { type: output.mimeType }));
    link.href = url; link.download = output.filename; document.body.append(link); link.click();
  } catch { throw new Error("Unable to create password output; authenticate again to retry"); }
  finally { link.remove(); if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000); }
}
