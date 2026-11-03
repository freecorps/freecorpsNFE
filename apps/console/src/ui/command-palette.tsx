import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";
import { holdModalLayer, restoreFocus } from "./focus";

export type Command = {
  id: string;
  label: string;
  group: string;
  icon?: IconName;
  /** Outros termos que encontram o comando ("nfse", "xml"). */
  keywords?: string;
  hint?: string;
  run: () => void;
};

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR");
export function filterCommands(commands: Command[], query: string) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return commands;
  return commands.filter((command) => {
    const text = normalize(`${command.label} ${command.group} ${command.keywords ?? ""}`);
    return terms.every((term) => text.includes(term));
  });
}

/**
 * Paleta de comandos (⌘K / Ctrl+K): navegação e ações rápidas. Uma caixa de busca com lista
 * (`combobox` + `listbox`); setas escolhem, Enter executa, Esc fecha e devolve o foco. Abre sem
 * animação: é um atalho de teclado usado muitas vezes por dia.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(<Palette onClose={onClose} commands={commands} />, document.body);
}

function Palette({ onClose, commands }: { onClose: () => void; commands: Command[] }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const groups = useMemo(() => {
    const map = new Map<string, Array<{ command: Command; index: number }>>();
    results.forEach((command, index) => {
      const list = map.get(command.group) ?? [];
      list.push({ command, index });
      map.set(command.group, list);
    });
    return [...map.entries()];
  }, [results]);
  useEffect(() => {
    opener.current = document.activeElement;
    const release = holdModalLayer();
    input.current?.focus();
    return () => {
      release();
      restoreFocus(opener.current);
    };
  }, []);
  useEffect(() => {
    document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);
  const current = Math.min(active, Math.max(results.length - 1, 0));
  function run(command: Command | undefined) {
    if (!command) return;
    onClose();
    command.run();
  }
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setActive((current + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setActive((current - 1 + results.length) % results.length);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      setActive(results.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[current]);
    } else if (event.key === "Tab") {
      // Só a busca recebe foco; a lista se percorre com as setas.
      event.preventDefault();
    }
  }
  return (
    <div
      className="ui-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ui-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Buscar ou ir para"
        onKeyDown={onKey}
      >
        <div className="ui-palette__search">
          <Icon name="search" />
          <input
            ref={input}
            className="ui-palette__input"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={results.length ? `${id}-list` : undefined}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? `${id}-option-${current}` : undefined}
            aria-label="Buscar telas e ações"
            placeholder="Buscar telas e ações…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
        </div>
        {results.length > 0 && (
          <div
            id={`${id}-list`}
            className="ui-palette__list"
            role="listbox"
            aria-label="Resultados"
          >
            {groups.map(([group, entries], groupIndex) => (
              <div key={group} role="group" aria-labelledby={`${id}-group-${groupIndex}`}>
                <p id={`${id}-group-${groupIndex}`} className="ui-palette__group">
                  {group}
                </p>
                {entries.map(({ command, index }) => (
                  <div
                    key={command.id}
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={index === current}
                    className="ui-palette__option"
                    onMouseMove={() => setActive(index)}
                    onClick={() => run(command)}
                  >
                    {command.icon && <Icon name={command.icon} />}
                    <span>{command.label}</span>
                    {command.hint && <span className="ui-palette__hint">{command.hint}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {!results.length && (
          <p className="ui-palette__empty" role="status">
            Nada encontrado para “{query}”.
          </p>
        )}
        <div className="ui-palette__footer" aria-hidden="true">
          <span>
            <kbd className="ui-kbd">↑</kbd>
            <kbd className="ui-kbd">↓</kbd> escolher
          </span>
          <span>
            <kbd className="ui-kbd">Enter</kbd> abrir
          </span>
          <span>
            <kbd className="ui-kbd">Esc</kbd> fechar
          </span>
        </div>
      </div>
    </div>
  );
}
