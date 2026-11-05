// Проверка ADR и карточек требований по docs/standards/README.md: фронтматтер, обязательные
// разделы, статусы, двусторонние ссылки замены и собранный индекс README.md в каждом каталоге.
//   node docs/standards/scripts/check-docs.mjs                      проверить каталоги по умолчанию
//   node docs/standards/scripts/check-docs.mjs --write              пересобрать индексы
//   node docs/standards/scripts/check-docs.mjs --strict             файлы без фронтматтера считаются ошибкой
//   node docs/standards/scripts/check-docs.mjs --dir <путь> [--dir <путь>] [--no-index] [--project <имя>]
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DEFAULT_DIRS = ["docs/architecture/decisions", "docs/requirements"]
const START = "<!-- docs-index:start -->"
const END = "<!-- docs-index:end -->"

const STATUSES = {
  ADR: ["Proposed", "Accepted", "Superseded", "Deprecated", "Rejected", "Withdrawn"],
  REQ: ["Draft", "Approved", "Implemented", "Rejected", "Superseded", "Withdrawn"],
}
const OWNER_ONLY = new Set(["Accepted", "Deprecated", "Approved", "Implemented"])
const SECTIONS = {
  ADR: ["Статус", "Контекст", "Рассмотренные альтернативы", "Принятое решение", "Последствия", "Открытые вопросы"],
  REQ: ["Статус", "Источник", "Проблема", "Цель", "Пользователи", "Границы", "Критерии приёмки", "Открытые вопросы"],
}
const FIELDS = {
  ADR: ["id", "status", "date", "decided_by", "decided_on", "supersedes", "superseded_by", "requirements"],
  REQ: ["id", "status", "date", "decided_by", "decided_on", "source", "supersedes", "superseded_by", "decisions"],
}
const INDEX_TITLE = { ADR: "# Решения (ADR)", REQ: "# Требования", mixed: "# Документы" }

const ID_RE = /^([a-z0-9][a-z0-9-]*)\/(ADR|REQ)-(\d{4})$/
const FILE_RE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const args = process.argv.slice(2)
const write = args.includes("--write")
const strict = args.includes("--strict")
const noIndex = args.includes("--no-index")
const dirs = []
let project = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") dirs.push(args[++i])
  if (args[i] === "--project") project = args[++i]
}
if (dirs.length === 0) dirs.push(...DEFAULT_DIRS)

const problems = []
const warnings = []
const rel = (file) => path.relative(ROOT, file).replaceAll("\\", "/")

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
  for (const line of lines) {
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
    else if (title === null && line.trim() !== "") {
      // текст до заголовка H1
      title = ""
    }
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
  return fs
    .readdirSync(abs)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => path.join(abs, name))
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
      ;(strict ? problems : warnings).push(
        `${rel(file)}: нет фронтматтера, документ ещё не переведён на стандарт`,
      )
      continue
    }
    const { data, body } = parsed
    const idMatch = typeof data.id === "string" ? data.id.match(ID_RE) : null
    if (!idMatch) {
      problems.push(`${rel(file)}: id «${data.id}» не вида <проект>/ADR-NNNN или <проект>/REQ-NNNN`)
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

for (const doc of docs) {
  const where = rel(doc.file)
  const { data, type } = doc
  const fail = (text) => problems.push(`${where}: ${text}`)

  const fileMatch = path.basename(doc.file).match(FILE_RE)
  if (!fileMatch) fail("имя файла не вида NNNN-slug.md (четыре цифры, слаг латиницей через дефис)")
  else if (fileMatch[1] !== doc.number) fail(`номер в имени файла ${fileMatch[1]} не совпадает с id ${data.id}`)

  for (const field of FIELDS[type]) {
    if (!(field in data)) fail(`во фронтматтере нет поля ${field}`)
  }
  for (const field of Object.keys(data)) {
    if (!FIELDS[type].includes(field)) fail(`лишнее поле фронтматтера ${field}`)
  }

  if (!STATUSES[type].includes(data.status)) fail(`статус «${data.status}» не из словаря ${type}: ${STATUSES[type].join(", ")}`)
  if (!DATE_RE.test(String(data.date))) fail(`date «${data.date}» не вида YYYY-MM-DD`)
  if (!["owner", "agent"].includes(data.decided_by)) fail(`decided_by «${data.decided_by}» должно быть owner или agent`)
  if (data.decided_on !== null && !DATE_RE.test(String(data.decided_on))) fail(`decided_on «${data.decided_on}» не дата и не null`)
  if (OWNER_ONLY.has(data.status)) {
    if (data.decided_by !== "owner") fail(`статус ${data.status} требует decided_by: owner`)
    if (data.decided_on === null) fail(`статус ${data.status} требует дату в decided_on`)
  }
  if (type === "REQ" && (typeof data.source !== "string" || data.source.trim() === "")) fail("source должен быть непустой строкой")

  const lists = type === "ADR" ? ["supersedes", "requirements"] : ["supersedes", "decisions"]
  for (const field of lists) {
    if (field in data && !Array.isArray(data[field])) fail(`${field} должно быть списком в квадратных скобках`)
  }
  if ("superseded_by" in data && data.superseded_by !== null && typeof data.superseded_by !== "string") fail("superseded_by должно быть id или null")

  if ((data.status === "Superseded") !== (data.superseded_by !== null && data.superseded_by !== undefined)) {
    fail("superseded_by заполнен тогда и только тогда, когда статус Superseded")
  }

  const refs = []
  for (const field of lists) if (Array.isArray(data[field])) for (const id of data[field]) refs.push([field, id])
  if (typeof data.superseded_by === "string") refs.push(["superseded_by", data.superseded_by])
  for (const [field, id] of refs) {
    const m = typeof id === "string" ? id.match(ID_RE) : null
    if (!m) {
      fail(`${field}: ссылка «${id}» не вида <проект>/ADR-NNNN или <проект>/REQ-NNNN`)
      continue
    }
    if (m[1] === doc.project && scannedTypes.has(m[2]) && !byId.has(id)) fail(`${field}: документа ${id} нет`)
    if (field === "supersedes" && m[2] !== type) fail(`supersedes: ${id} другого типа, заменять можно только ${type}`)
    if (field === "superseded_by" && m[2] !== type) fail(`superseded_by: ${id} другого типа`)
    if (field === "requirements" && m[2] !== "REQ") fail(`requirements: ${id} не требование`)
    if (field === "decisions" && m[2] !== "ADR") fail(`decisions: ${id} не ADR`)
  }
  if (Array.isArray(data.supersedes)) {
    for (const id of data.supersedes) {
      const other = byId.get(id)
      if (!other) continue
      if (other.data.superseded_by !== data.id) fail(`supersedes ${id}, но у него superseded_by = ${other.data.superseded_by}`)
    }
  }
  if (typeof data.superseded_by === "string") {
    const other = byId.get(data.superseded_by)
    if (other && !(Array.isArray(other.data.supersedes) && other.data.supersedes.includes(data.id))) {
      fail(`superseded_by ${data.superseded_by}, но тот не перечисляет ${data.id} в supersedes`)
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

// --- индекс ------------------------------------------------------------------

function escapeCell(text) {
  return text.replaceAll("|", "\\|")
}

function indexTable(list) {
  const mixed = new Set(list.map((doc) => doc.type)).size > 1
  const rows = [...list]
    .sort((a, b) => a.type.localeCompare(b.type) || a.number.localeCompare(b.number))
    .map((doc) => {
      const name = path.basename(doc.file)
      const title = (doc.title ?? "").replace(/^\d{4}\. /, "") || name
      const replaced = typeof doc.data.superseded_by === "string" ? `\`${doc.data.superseded_by}\`` : ""
      const number = mixed ? `[${doc.type}-${doc.number}](${name})` : `[${doc.number}](${name})`
      return `| ${number} | ${escapeCell(title)} | ${doc.data.status} | ${replaced} |`
    })
  return ["| № | Название | Статус | Заменён |", "|---|---|---|---|", ...rows].join("\n")
}

function indexBlock(list) {
  return `${START}\n${indexTable(list)}\n${END}`
}

if (!noIndex) {
  for (const dir of dirs) {
    const list = docs.filter((doc) => doc.dir === dir)
    if (list.length === 0) continue
    const readme = path.join(ROOT, dir, "README.md")
    const types = new Set(list.map((doc) => doc.type))
    const title = types.size === 1 ? INDEX_TITLE[[...types][0]] : INDEX_TITLE.mixed
    const existing = fs.existsSync(readme) ? fs.readFileSync(readme, "utf8") : null
    const expected = indexBlock(list)
    let next
    if (existing === null) {
      next = `${title}\n\nФормат документов — \`docs/standards/README.md\`. Таблицу собирает \`node docs/standards/scripts/check-docs.mjs --write\`, руками её не правят.\n\n${expected}\n`
    } else {
      const start = existing.indexOf(START)
      const end = existing.indexOf(END)
      if (start < 0 || end < 0 || end < start) {
        next = `${existing.trimEnd()}\n\n${expected}\n`
      } else {
        next = existing.slice(0, start) + expected + existing.slice(end + END.length)
      }
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
