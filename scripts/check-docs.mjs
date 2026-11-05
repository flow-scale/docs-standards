// Проверка ADR, карточек требований и контрактов по docs/standards/README.md: фронтматтер,
// обязательные разделы, статусы, двусторонние ссылки замены, пути enforced_by, покрытие проверок
// контрактами и собранный индекс README.md в каждом каталоге.
//   node docs/standards/scripts/check-docs.mjs                      проверить каталоги по умолчанию
//   node docs/standards/scripts/check-docs.mjs --write              пересобрать индексы
//   node docs/standards/scripts/check-docs.mjs --strict             файлы без фронтматтера считаются ошибкой
//   node docs/standards/scripts/check-docs.mjs --dir <путь> [--dir <путь>]   каталоги документов;
//                                                                   подкаталоги первого уровня тоже читаются
//   node docs/standards/scripts/check-docs.mjs --enforced <путь>    каталог проверок (тесты, правила линтера):
//                                                                   каждый файл в нём должен быть назван в enforced_by
//                                                                   хотя бы одного контракта, иначе предупреждение
//   node docs/standards/scripts/check-docs.mjs --strict-coverage    непокрытая проверка и контракт без проверки — ошибки
//   [--no-index] [--project <имя>]
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DEFAULT_DIRS = ["docs/architecture/decisions", "docs/requirements", "docs/contracts"]
const START = "<!-- docs-index:start -->"
const END = "<!-- docs-index:end -->"

const STATUSES = {
  ADR: ["Proposed", "Accepted", "Superseded", "Deprecated", "Rejected", "Withdrawn"],
  REQ: ["Draft", "Approved", "Implemented", "Rejected", "Superseded", "Withdrawn"],
  CON: ["Draft", "Accepted", "Deprecated", "Superseded", "Withdrawn"],
}
const OWNER_ONLY = new Set(["Accepted", "Deprecated", "Approved", "Implemented"])
const SECTIONS = {
  ADR: ["Статус", "Контекст", "Рассмотренные альтернативы", "Принятое решение", "Последствия", "Открытые вопросы"],
  REQ: ["Статус", "Источник", "Проблема", "Цель", "Пользователи", "Границы", "Критерии приёмки", "Открытые вопросы"],
  CON: ["Статус", "Стороны", "Что гарантируется", "Как проверяется", "Изменение контракта", "Открытые вопросы"],
}
const FIELDS = {
  ADR: ["id", "status", "date", "decided_by", "decided_on", "supersedes", "superseded_by", "requirements"],
  REQ: ["id", "status", "date", "decided_by", "decided_on", "source", "supersedes", "superseded_by", "decisions"],
  CON: [
    "id", "kind", "status", "date", "decided_by", "decided_on", "parties", "enforced_by",
    "supersedes", "superseded_by", "decisions", "requirements",
  ],
}
const LIST_FIELDS = {
  ADR: ["supersedes", "requirements"],
  REQ: ["supersedes", "decisions"],
  CON: ["supersedes", "decisions", "requirements", "enforced_by"],
}
const KINDS = ["architecture", "code", "service", "external", "data", "double"]
const INDEX_TITLE = { ADR: "# Решения (ADR)", REQ: "# Требования", CON: "# Контракты", mixed: "# Документы" }

const ID_RE = /^([a-z0-9][a-z0-9-]*)\/(ADR|REQ|CON)-(\d{4})$/
const FILE_RE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const args = process.argv.slice(2)
const write = args.includes("--write")
const strict = args.includes("--strict")
const strictCoverage = args.includes("--strict-coverage")
const noIndex = args.includes("--no-index")
const dirs = []
const enforcedDirs = []
let project = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") dirs.push(args[++i])
  if (args[i] === "--enforced") enforcedDirs.push(args[++i])
  if (args[i] === "--project") project = args[++i]
}
if (dirs.length === 0) dirs.push(...DEFAULT_DIRS)

const problems = []
const warnings = []
const rel = (file) => path.relative(ROOT, file).replaceAll("\\", "/")
const coverageProblem = (text) => (strictCoverage ? problems : warnings).push(text)

// --- фронтматтер -------------------------------------------------------------

function unquote(value) {
  const m = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/)
  return m ? m[1] : value
}

function parseValue(raw, where) {
  const value = raw.trim()
  if (value === "" || value === "null" || value === "~") return null
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`${where}: список не закрыт`)
    const inner = value.slice(1, -1).trim()
    return inner === "" ? [] : inner.split(",").map((item) => unquote(item.trim()))
  }
  return unquote(value)
}

function parseFrontmatter(text) {
  if (!/^---\r?\n/.test(text)) return null
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!m) throw new Error("фронтматтер открыт, но не закрыт строкой ---")
  const data = {}
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim()
    if (!line) continue
    const kv = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!kv) throw new Error(`строка фронтматтера не разобрана: «${raw}»`)
    data[kv[1]] = parseValue(kv[2], kv[1])
  }
  return { data, body: text.slice(m[0].length) }
}

// --- тело --------------------------------------------------------------------

function parseBody(body) {
  const lines = body.split(/\r?\n/)
  let title = null
  const sections = []
  let current = null
  let inCode = false
  for (const line of lines) {
    if (/^```/.test(line)) inCode = !inCode
    if (inCode) {
      if (current) current.lines.push(line)
      continue
    }
    const h1 = line.match(/^# (.+)$/)
    if (h1 && title === null && current === null) {
      title = h1[1].trim()
      continue
    }
    const h2 = line.match(/^## (.+)$/)
    if (h2) {
      current = { name: h2[1].trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else if (title === null && line.trim() !== "") title = ""
  }
  return { title, sections }
}

function firstLine(section) {
  return section.lines.map((line) => line.trim()).find((line) => line !== "") ?? ""
}

// --- сбор документов ---------------------------------------------------------

function listDocs(dir) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) {
    warnings.push(`${dir}: каталога нет, пропущен`)
    return []
  }
  const files = []
  for (const name of fs.readdirSync(abs).sort()) {
    const full = path.join(abs, name)
    if (fs.statSync(full).isDirectory()) {
      for (const inner of fs.readdirSync(full).sort()) {
        if (inner.endsWith(".md") && inner !== "README.md") files.push(path.join(full, inner))
      }
    } else if (name.endsWith(".md") && name !== "README.md") {
      files.push(full)
    }
  }
  return files
}

const docs = []
const legacy = []

for (const dir of dirs) {
  for (const file of listDocs(dir)) {
    const text = fs.readFileSync(file, "utf8")
    let parsed
    try {
      parsed = parseFrontmatter(text)
    } catch (error) {
      problems.push(`${rel(file)}: ${error.message}`)
      continue
    }
    if (!parsed) {
      legacy.push(file)
      ;(strict ? problems : warnings).push(`${rel(file)}: нет фронтматтера, документ ещё не переведён на стандарт`)
      continue
    }
    const { data, body } = parsed
    const idMatch = typeof data.id === "string" ? data.id.match(ID_RE) : null
    if (!idMatch) {
      problems.push(`${rel(file)}: id «${data.id}» не вида <проект>/ADR-NNNN, <проект>/REQ-NNNN или <проект>/CON-NNNN`)
      continue
    }
    docs.push({
      file,
      dir,
      data,
      body,
      project: idMatch[1],
      type: idMatch[2],
      number: idMatch[3],
      ...parseBody(body),
    })
  }
}

// --- проверки одного документа -----------------------------------------------

const byId = new Map()
for (const doc of docs) {
  if (byId.has(doc.data.id)) problems.push(`${rel(doc.file)}: id ${doc.data.id} уже есть в ${rel(byId.get(doc.data.id).file)}`)
  else byId.set(doc.data.id, doc)
}
const scannedTypes = new Set(docs.map((doc) => doc.type))
const projects = new Set(docs.map((doc) => doc.project))
if (project && projects.size > 0 && (projects.size > 1 || !projects.has(project))) {
  problems.push(`ожидался проект ${project}, в id встречаются: ${[...projects].join(", ")}`)
} else if (!project && projects.size > 1) {
  problems.push(`в id встречаются разные проекты: ${[...projects].join(", ")}`)
}

const enforcedRefs = new Set()

for (const doc of docs) {
  const where = rel(doc.file)
  const { data, type } = doc
  const fail = (text) => problems.push(`${where}: ${text}`)

  const fileMatch = path.basename(doc.file).match(FILE_RE)
  if (!fileMatch) fail("имя файла не вида NNNN-slug.md (четыре цифры, слаг латиницей через дефис)")
  else if (fileMatch[1] !== doc.number) fail(`номер в имени файла ${fileMatch[1]} не совпадает с id ${data.id}`)

  for (const field of FIELDS[type]) if (!(field in data)) fail(`во фронтматтере нет поля ${field}`)
  for (const field of Object.keys(data)) if (!FIELDS[type].includes(field)) fail(`лишнее поле фронтматтера ${field}`)

  if (!STATUSES[type].includes(data.status)) fail(`статус «${data.status}» не из словаря ${type}: ${STATUSES[type].join(", ")}`)
  if (!DATE_RE.test(String(data.date))) fail(`date «${data.date}» не вида YYYY-MM-DD`)
  if (!["owner", "agent"].includes(data.decided_by)) fail(`decided_by «${data.decided_by}» должно быть owner или agent`)
  if (data.decided_on !== null && !DATE_RE.test(String(data.decided_on))) fail(`decided_on «${data.decided_on}» не дата и не null`)
  if (OWNER_ONLY.has(data.status)) {
    if (data.decided_by !== "owner") fail(`статус ${data.status} требует decided_by: owner`)
    if (data.decided_on === null) fail(`статус ${data.status} требует дату в decided_on`)
  }
  if (type === "REQ" && (typeof data.source !== "string" || data.source.trim() === "")) fail("source должен быть непустой строкой")
  if (type === "CON") {
    if (!KINDS.includes(data.kind)) fail(`kind «${data.kind}» не из списка: ${KINDS.join(", ")}`)
    if (typeof data.parties !== "string" || data.parties.trim() === "") fail("parties должен быть непустой строкой «кто ↔ кто»")
  }

  for (const field of LIST_FIELDS[type]) {
    if (field in data && !Array.isArray(data[field])) fail(`${field} должно быть списком в квадратных скобках`)
  }
  if ("superseded_by" in data && data.superseded_by !== null && typeof data.superseded_by !== "string") fail("superseded_by должно быть id или null")
  if ((data.status === "Superseded") !== (data.superseded_by !== null && data.superseded_by !== undefined)) {
    fail("superseded_by заполнен тогда и только тогда, когда статус Superseded")
  }

  const refs = []
  for (const field of LIST_FIELDS[type]) {
    if (field === "enforced_by" || !Array.isArray(data[field])) continue
    for (const id of data[field]) refs.push([field, id])
  }
  if (typeof data.superseded_by === "string") refs.push(["superseded_by", data.superseded_by])
  for (const [field, id] of refs) {
    const m = typeof id === "string" ? id.match(ID_RE) : null
    if (!m) {
      fail(`${field}: ссылка «${id}» не вида <проект>/ADR-NNNN, <проект>/REQ-NNNN или <проект>/CON-NNNN`)
      continue
    }
    if (m[1] === doc.project && scannedTypes.has(m[2]) && !byId.has(id)) fail(`${field}: документа ${id} нет`)
    if ((field === "supersedes" || field === "superseded_by") && m[2] !== type) fail(`${field}: ${id} другого типа`)
    if (field === "requirements" && m[2] !== "REQ") fail(`requirements: ${id} не требование`)
    if (field === "decisions" && m[2] !== "ADR") fail(`decisions: ${id} не ADR`)
  }
  if (Array.isArray(data.supersedes)) {
    for (const id of data.supersedes) {
      const other = byId.get(id)
      if (other && other.data.superseded_by !== data.id) fail(`supersedes ${id}, но у него superseded_by = ${other.data.superseded_by}`)
    }
  }
  if (typeof data.superseded_by === "string") {
    const other = byId.get(data.superseded_by)
    if (other && !(Array.isArray(other.data.supersedes) && other.data.supersedes.includes(data.id))) {
      fail(`superseded_by ${data.superseded_by}, но тот не перечисляет ${data.id} в supersedes`)
    }
  }

  if (type === "CON" && Array.isArray(data.enforced_by)) {
    for (const p of data.enforced_by) {
      if (typeof p !== "string" || p.trim() === "") {
        fail("enforced_by: пустой путь")
        continue
      }
      const abs = path.join(ROOT, p)
      if (!fs.existsSync(abs)) fail(`enforced_by: пути ${p} нет`)
      else enforcedRefs.add(rel(abs))
    }
    if (data.enforced_by.length === 0 && data.status !== "Withdrawn") {
      coverageProblem(`${where}: контракт ничем не проверяется (enforced_by пуст)`)
    }
  }

  const titleMatch = (doc.title ?? "").match(/^(\d{4})\. (.+)$/)
  if (!titleMatch) fail("первой строкой тела нужен заголовок «# NNNN. Название»")
  else if (titleMatch[1] !== doc.number) fail(`номер в заголовке ${titleMatch[1]} не совпадает с id`)

  const names = doc.sections.map((section) => section.name)
  let cursor = 0
  for (const required of SECTIONS[type]) {
    const index = names.indexOf(required, cursor)
    if (index < 0) {
      fail(names.includes(required) ? `раздел «${required}» стоит не на своём месте` : `нет раздела «## ${required}»`)
      continue
    }
    cursor = index + 1
  }
  const status = doc.sections.find((section) => section.name === "Статус")
  if (status && STATUSES[type].includes(data.status) && !firstLine(status).startsWith(data.status)) {
    fail(`раздел «Статус» должен начинаться со слова ${data.status}`)
  }
  const open = doc.sections.find((section) => section.name === "Открытые вопросы")
  if (open && firstLine(open) === "") fail("раздел «Открытые вопросы» пуст: напиши «Нет.» или вопросы")
  if (type === "REQ") {
    const bounds = doc.sections.find((section) => section.name === "Границы")
    if (bounds) {
      const text = bounds.lines.join("\n")
      if (!/^Входит:/m.test(text) || !/^Не входит:/m.test(text)) fail("в «Границы» нужны строки «Входит:» и «Не входит:»")
    }
    const criteria = doc.sections.find((section) => section.name === "Критерии приёмки")
    if (criteria && !criteria.lines.some((line) => /^\d+\.\s/.test(line))) fail("критерии приёмки должны быть нумерованным списком")
  }
}

// --- покрытие проверок контрактами ------------------------------------------

function listEnforced(dir) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) {
    warnings.push(`${dir}: каталога проверок нет, пропущен`)
    return []
  }
  const out = []
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name)
      if (name === "__pycache__" || name === "node_modules") continue
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (/^test_.*\.py$/.test(name) || /\.(toml|mjs|ts|sql)$/.test(name)) out.push(full)
    }
  }
  walk(abs)
  return out
}

for (const dir of enforcedDirs) {
  for (const file of listEnforced(dir)) {
    const r = rel(file)
    const covered = [...enforcedRefs].some((ref) => r === ref || r.startsWith(ref + "/"))
    if (!covered) coverageProblem(`${r}: проверка не названа ни в одном контракте (enforced_by)`)
  }
}

// --- индекс ------------------------------------------------------------------

function escapeCell(text) {
  return text.replaceAll("|", "\\|")
}

function indexTable(list, dir) {
  const mixed = new Set(list.map((doc) => doc.type)).size > 1
  const withKind = list.some((doc) => doc.type === "CON")
  const rows = [...list]
    .sort((a, b) => a.type.localeCompare(b.type) || a.number.localeCompare(b.number))
    .map((doc) => {
      const link = path.relative(path.join(ROOT, dir), doc.file).replaceAll("\\", "/")
      const title = (doc.title ?? "").replace(/^\d{4}\. /, "") || path.basename(doc.file)
      const replaced = typeof doc.data.superseded_by === "string" ? `\`${doc.data.superseded_by}\`` : ""
      const number = mixed ? `[${doc.type}-${doc.number}](${link})` : `[${doc.number}](${link})`
      const kind = withKind ? ` ${doc.data.kind ?? ""} |` : ""
      return `| ${number} |${kind} ${escapeCell(title)} | ${doc.data.status} | ${replaced} |`
    })
  const head = withKind ? "| № | Вид | Название | Статус | Заменён |" : "| № | Название | Статус | Заменён |"
  const sep = withKind ? "|---|---|---|---|---|" : "|---|---|---|---|"
  return [head, sep, ...rows].join("\n")
}

function indexBlock(list, dir) {
  return `${START}\n${indexTable(list, dir)}\n${END}`
}

if (!noIndex) {
  for (const dir of dirs) {
    const list = docs.filter((doc) => doc.dir === dir)
    if (list.length === 0) continue
    const readme = path.join(ROOT, dir, "README.md")
    const types = new Set(list.map((doc) => doc.type))
    const title = types.size === 1 ? INDEX_TITLE[[...types][0]] : INDEX_TITLE.mixed
    const existing = fs.existsSync(readme) ? fs.readFileSync(readme, "utf8") : null
    const expected = indexBlock(list, dir)
    let next
    if (existing === null) {
      next = `${title}\n\nФормат документов — \`docs/standards/README.md\`. Таблицу собирает \`node docs/standards/scripts/check-docs.mjs --write\`, руками её не правят.\n\n${expected}\n`
    } else {
      const start = existing.indexOf(START)
      const end = existing.indexOf(END)
      if (start < 0 || end < 0 || end < start) next = `${existing.trimEnd()}\n\n${expected}\n`
      else next = existing.slice(0, start) + expected + existing.slice(end + END.length)
    }
    if (existing !== next) {
      if (write && problems.length === 0) {
        fs.writeFileSync(readme, next)
        console.log(`индекс собран: ${rel(readme)}`)
      } else if (write) {
        problems.push(`${rel(readme)}: индекс не пересобран, сначала исправь ошибки выше`)
      } else {
        problems.push(`${rel(readme)}: индекс расходится с документами, запусти node docs/standards/scripts/check-docs.mjs --write`)
      }
    }
  }
}

// --- итог --------------------------------------------------------------------

for (const warning of warnings) console.error(`предупреждение: ${warning}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}
console.log(
  `документы в порядке: ${docs.length} по стандарту${legacy.length ? `, ${legacy.length} без фронтматтера` : ""}`,
)
