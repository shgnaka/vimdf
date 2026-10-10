import type { PasswordAnswer } from "./passwords";
import { createPasswordStore, type EncryptedPasswordStore } from "../common/password-store";
import { vaultDialog } from "../common/vault-dialog";

export function showPasswordPrompt(info: { incorrect: boolean; signal: AbortSignal; store?: EncryptedPasswordStore }): Promise<PasswordAnswer | null> {
  if (info.signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "password-dialog";
    dialog.setAttribute("aria-labelledby", "password-heading");
    dialog.innerHTML = `
      <form>
        <h2 id="password-heading">PDF password</h2>
        <p role="alert">${info.incorrect ? "That password did not open this PDF. Try another password." : "Enter the password to open this PDF."}</p>
        <label>Password <input name="password" type="password" autocomplete="off" required autofocus /></label>
        <label><input name="visible" type="checkbox" /> Show password</label>
        <label><input name="remember" type="checkbox" /> Save after this PDF opens successfully</label>
        <fieldset disabled hidden>
          <label>Name <input name="name" type="text" placeholder="e.g. Course materials" /></label>
          <label><input name="shared" type="checkbox" checked /> Automatically try this password on other PDFs</label>
          <p>Saved encrypted in this browser profile. Unlock the vault to save a password.</p>
        </fieldset>
        <p class="password-private" hidden>Incognito: passwords will not be loaded or saved.</p>
        <div class="password-actions"><button type="button" name="unlock">Unlock vault</button><button type="button" name="cancel">Cancel</button><button type="submit">Open PDF</button></div>
      </form>`;
    const form = dialog.querySelector("form")!;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    const remember = form.elements.namedItem("remember") as HTMLInputElement;
    const fieldset = dialog.querySelector("fieldset")!;
    const store = info.store ?? createPasswordStore(info.signal);
    const unlock = form.elements.namedItem("unlock") as HTMLButtonElement;
    remember.disabled = true; unlock.disabled = true;
    void store.status().then(({ state }) => {
      remember.disabled = state !== "unlocked";
      unlock.hidden = state !== "locked";
      unlock.disabled = state !== "locked";
    }).catch(() => { unlock.hidden = true; });
    unlock.addEventListener("click", () => {
      const modal = vaultDialog("Unlock password vault", ["Master password"]);
      const active = createPasswordStore(modal.signal);
      const abort = () => modal.close(); info.signal.addEventListener("abort", abort, { once: true });
      modal.signal.addEventListener("abort", () => { info.signal.removeEventListener("abort", abort); if (password.isConnected) password.focus(); });
      modal.button("Unlock", async () => {
        await active.unlock(modal.inputs.get("Master password")!.value);
        modal.close(); finish({ password: "", name: "", shared: false, remember: false, retrySaved: true });
      });
    });
    if (chrome.extension.inIncognitoContext) {
      remember.disabled = true;
      (dialog.querySelector(".password-private") as HTMLElement).hidden = false;
    }
    let finished = false;
    const finish = (answer: PasswordAnswer | null): void => {
      if (finished) return;
      finished = true;
      info.signal.removeEventListener("abort", abort);
      password.value = "";
      dialog.close();
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(answer);
    };
    const abort = (): void => finish(null);
    info.signal.addEventListener("abort", abort, { once: true });
    (form.elements.namedItem("visible") as HTMLInputElement).addEventListener("change", event => {
      password.type = (event.target as HTMLInputElement).checked ? "text" : "password";
    });
    remember.addEventListener("change", () => {
      fieldset.hidden = !remember.checked;
      fieldset.disabled = !remember.checked;
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!password.value.length) { password.focus(); return; }
      finish({
        password: password.value,
        name: (form.elements.namedItem("name") as HTMLInputElement).value,
        remember: remember.checked && !remember.disabled,
        shared: (form.elements.namedItem("shared") as HTMLInputElement).checked,
      });
    });
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
    dialog.addEventListener("keydown", event => {
      if (event.isComposing && (event.key === "Enter" || event.key === "Escape")) event.preventDefault();
      event.stopPropagation();
    });
    (form.elements.namedItem("cancel") as HTMLButtonElement).addEventListener("click", () => finish(null));
    document.body.append(dialog);
    dialog.showModal();
    password.focus();
  });
}
