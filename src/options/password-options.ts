import { createPasswordStore } from "../common/password-store";

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
  const error = (e: unknown): void => {
    status.textContent = e instanceof Error ? e.message : "Could not save passwords";
  };
  const perform = (action: () => Promise<void>): void => {
    void action().then(() => { status.textContent = "Saved"; return render(); }).catch(error);
  };
  const render = async (): Promise<void> => {
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
  };
  if (chrome.extension.inIncognitoContext) {
    status.textContent = "Incognito: password registration and autofill are disabled.";
    section.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(el => { el.disabled = true; });
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
}
