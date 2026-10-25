// Routines (#163): a named list of spoken steps, per project ("grava a
// rotina começar o dia: o que temos pra hoje, depois revisa a PR 166").
// Found by name whatever the accents or case. Persisted in
// ~/.config/vizor/voz/rotinas.json: { "<root>": { "<key>": { name, steps } } }.
const keyOf = (name) =>
  String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function createRoutines({ file, readFile, writeFile, rename }) {
  let data = {};
  try {
    data = JSON.parse(readFile(file)) ?? {};
  } catch {
    data = {};
  }
  const save = () => {
    writeFile(`${file}.tmp`, JSON.stringify(data));
    rename(`${file}.tmp`, file);
  };
  return {
    save(root, name, steps) {
      const project = (data[root] ??= {});
      delete project[keyOf(name)];
      project[keyOf(name)] = { name: String(name).trim(), steps: [...steps] };
      save();
    },
    get(root, name) {
      const routine = data[root]?.[keyOf(name)];
      return routine ? { name: routine.name, steps: [...routine.steps] } : null;
    },
    list(root) {
      return Object.values(data[root] ?? {}).map((routine) => ({ name: routine.name, steps: [...routine.steps] }));
    },
    remove(root, name) {
      if (!data[root]?.[keyOf(name)]) return false;
      delete data[root][keyOf(name)];
      save();
      return true;
    },
  };
}
