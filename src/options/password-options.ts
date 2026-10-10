import { createPasswordStore } from "../common/password-store";
import { downloadVault, vaultDialog } from "../common/vault-dialog";

export function setupPasswordOptions(): void {
  const section = document.getElementById("passwordSettings")!;
  const form = section.querySelector("form")!;
  const list = section.querySelector(".password-list")!;
  const status = section.querySelector(".password-status")!;
  const global = section.querySelector<HTMLInputElement>("#passwordAutoFill")!;
  const clear = section.querySelector<HTMLButtonElement>("#passwordClear")!;
  const secret = form.elements.namedItem("password") as HTMLInputElement;
  const name = form.elements.namedItem("name") as HTMLInputElement;
  const shared = form.elements.namedItem("shared") as HTMLInputElement;
  const store = createPasswordStore();
  const vaultStatus = section.querySelector<HTMLElement>("#passwordVaultStatus")!;
  let rendering = false;
  const error = (e: unknown): void => {
    status.textContent = e instanceof Error ? e.message : "Could not save passwords";
    vaultStatus.textContent = status.textContent;
  };
  const perform = (action: () => Promise<void>): void => {
    void action().then(() => { status.textContent = "Saved"; forceRender = true; return render(); }).catch(error);
  };
  const render = async (): Promise<void> => {
    if (rendering) return;
    rendering = true;
    try {
    const { state } = await store.status();
    const changed = section.dataset.vaultState !== state;
    section.dataset.vaultState = state;
    vaultStatus.textContent = ({ uninitialized: "Create a vault to save PDF passwords.", locked: "Password vault locked.",
      unlocked: "Password vault unlocked in this page.", legacy: "Legacy plaintext passwords need explicit migration.",
      "migration-pending": "Incomplete migration: remaining plaintext must be removed.", incognito: "Incognito: password vault disabled." })[state];
    const enabled: Record<string, boolean> = { passwordCreateVault: state === "uninitialized", passwordUnlockVault: state === "locked",
      passwordLockVault: state === "unlocked", passwordBackup: state === "locked" || state === "unlocked",
      passwordRestore: state === "uninitialized" || state === "unlocked", passwordExportPlaintext: state === "locked" || state === "unlocked",
      passwordChangeMaster: state === "unlocked", passwordResetVault: state !== "incognito" && state !== "uninitialized",
      passwordMigrate: state === "legacy" || state === "migration-pending" };
    for (const [id, value] of Object.entries(enabled)) (section.querySelector(`#${id}`) as HTMLButtonElement).disabled = !value;
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(input => { input.disabled = state !== "unlocked"; });
    global.disabled = clear.disabled = state !== "unlocked";
    if (state !== "unlocked") { secret.value = ""; name.value = ""; list.replaceChildren(); return; }
    // Keep an edited row intact during passive status refreshes.
    if (!changed && !forceRender) return;
    const vault = await store.vault();
    global.checked = vault.autoFill;
    list.replaceChildren();
    vault.records.forEach((record, index) => {
      const row = document.createElement("div");
      row.className = "password-record";
      const label = document.createElement("input");
      label.type = "text"; label.value = record.name; label.setAttribute("aria-label", "Password name");
      const password = document.createElement("input");
      password.type = "password"; password.value = record.password; password.autocomplete = "off";
      password.setAttribute("aria-label", "Saved password");
      const button = (text: string, action: () => void): HTMLButtonElement => {
        const b = document.createElement("button"); b.type = "button"; b.textContent = text;
        b.addEventListener("click", action); return b;
      };
      const checkbox = (text: string, checked: boolean, update: (value: boolean) => Promise<void>): HTMLLabelElement => {
        const wrapper = document.createElement("label");
        const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked;
        input.addEventListener("change", () => perform(() => update(input.checked)));
        wrapper.append(input, document.createTextNode(text)); return wrapper;
      };
      const up = button("Move up", () => perform(() => store.move(record.id, -1)));
      const down = button("Move down", () => perform(() => store.move(record.id, 1)));
      up.disabled = index === 0; down.disabled = index === vault.records.length - 1;
      row.append(label, password,
        button("Show / hide", () => { password.type = password.type === "password" ? "text" : "password"; }),
        button("Save changes", () => perform(() => store.update(record.id, {name: label.value, password: password.value}))),
        checkbox("Enabled", record.enabled, enabled => store.update(record.id, {enabled})),
        checkbox("Try on other PDFs", record.shared, value => store.update(record.id, {shared: value})),
        up, down, button("Delete", () => perform(() => store.remove(record.id))));
      list.append(row);
    });
    } finally { rendering = false; forceRender = false; }
  };
  let forceRender = true;
  const bind = (id: string, action: () => void) => section.querySelector(`#${id}`)!.addEventListener("click", action);
  const passwordAction = (id: string, title: string, label: string, fields: string[],
    action: (s: ReturnType<typeof createPasswordStore>, values: string[]) => Promise<void>, description = "") => {
    bind(id, () => {
      const modal = vaultDialog(title, fields, description), active = createPasswordStore(modal.signal);
      modal.button(label, async () => {
        vaultStatus.textContent = "Working…";
        await action(active, fields.map(f => modal.inputs.get(f)!.value));
        modal.close(); forceRender = true; await render();
      });
    });
  };
  passwordAction("passwordCreateVault", "Create password vault", "Create vault", ["Master password", "Confirm master password"],
    (s, v) => s.create(v[0], v[1]));
  passwordAction("passwordUnlockVault", "Unlock password vault", "Unlock", ["Master password"], (s, v) => s.unlock(v[0]));
  passwordAction("passwordMigrate", "Migrate password vault", "Encrypt saved passwords", ["Master password", "Confirm master password"],
    async (s, v) => { try { await s.migrate(v[0], v[1]); } finally { forceRender = true; await render(); } });
  passwordAction("passwordChangeMaster", "Change master password", "Change master password",
    ["Current master password", "New master password", "Confirm new master password"],
    (s, v) => s.changeMasterPassword(v[0], v[1], v[2]), "Existing backups still use the old master password. Make a new encrypted backup after changing it.");
  passwordAction("passwordExportPlaintext", "Export plaintext passwords", "Export plaintext", ["Master password"], async (s, v) => {
    const token = await s.authorizePlaintext(v[0]); downloadVault(await s.exportPlaintext(token, { confirmed: true }));
  }, "This creates a readable, unencrypted JSON file containing every saved PDF password. Confirm by entering the master password and choosing Export plaintext.");
  passwordAction("passwordResetVault", "Reset password vault", "Reset vault", [], s => s.reset({ confirmed: true }),
    "All saved PDF passwords will be lost. This cannot be undone without an encrypted backup. PDF files, folder registrations and settings are kept.");
  bind("passwordLockVault", () => perform(() => store.lock()));
  bind("passwordBackup", () => perform(async () => { downloadVault(await store.exportBackup()); }));
  bind("passwordRestore", () => {
    const modal = vaultDialog("Restore password vault", ["Backup master password"], "Validate the encrypted backup before replacing the current vault. Restored passwords use the backup master password.");
    const active = createPasswordStore(modal.signal);
    const file = document.createElement("input"); file.id = "passwordRestoreFile"; file.type = "file"; file.accept = ".json,application/json";
    file.setAttribute("aria-label", "Encrypted backup file"); modal.form.prepend(file);
    const preview = document.createElement("p"); modal.form.insertBefore(preview, modal.alert);
    let token: string | undefined;
    const commit = modal.button("Restore vault", async () => {
      if (!token) throw new Error("Validate the backup first");
      try { await active.restore(token, { confirmed: true }); }
      finally { token = undefined; commit.disabled = true; }
      modal.close(); forceRender = true; await render();
    }); commit.disabled = true;
    const invalidate = () => { if (token) void active.discardPrepared(token); token = undefined; preview.textContent = ""; commit.disabled = true; };
    file.addEventListener("change", invalidate); modal.inputs.get("Backup master password")!.addEventListener("input", invalidate);
    modal.signal.addEventListener("abort", invalidate);
    modal.button("Validate backup", async () => {
      invalidate(); const selected = file.files?.[0]; if (!selected) throw new Error("Choose an encrypted backup");
      if (selected.size > 2 * 1024 * 1024) throw new Error("Backup is too large");
      const result = await active.prepareRestore(await selected.text(), modal.inputs.get("Backup master password")!.value);
      token = result.token; modal.clear(); preview.textContent = `${result.preview.recordCount} saved passwords. ${result.preview.replacesExisting ? "This will replace the current vault." : "Create a vault from this backup."}`;
      commit.disabled = false;
    }, false);
  });
  if (chrome.extension.inIncognitoContext) {
    status.textContent = "Incognito: password registration and autofill are disabled.";
    section.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(el => { el.disabled = true; });
    void render().catch(error);
    return;
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    perform(async () => {
      await store.register({name: name.value, password: secret.value, shared: shared.checked});
      secret.value = ""; name.value = "";
    });
  });
  (form.elements.namedItem("visible") as HTMLInputElement).addEventListener("change", event => {
    secret.type = (event.target as HTMLInputElement).checked ? "text" : "password";
  });
  global.addEventListener("change", () => perform(() => store.setAutoFill(global.checked)));
  clear.addEventListener("click", () => {
    if (window.confirm("Delete all saved PDF passwords?")) perform(() => store.clear());
  });
  void render().catch(error);
  const refresh = () => { if (!document.querySelector("dialog[open]")) void render().catch(error); };
  const timer = setInterval(refresh, 1000);
  document.addEventListener("pointerdown", () => { void store.noteActivity().catch(() => {}); });
  document.addEventListener("keydown", () => { void store.noteActivity().catch(() => {}); });
  window.addEventListener("pagehide", () => { clearInterval(timer); void store.lock(); }, { once: true });
}
