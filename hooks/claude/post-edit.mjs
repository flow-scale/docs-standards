// Хук Claude Code PostToolUse: после правки ADR, карточки требования или контракта запускает
// check-docs.mjs и возвращает ошибки агенту, пока он ещё в задаче, а не на пуше или в CI.
//
//   node docs/standards/hooks/claude/post-edit.mjs [аргументы check-docs.mjs]
//
// Вход: JSON события на stdin (tool_input.file_path). Если файл не из каталогов документов,
// хук молчит. При ошибках печатает их в stderr и выходит с кодом 2: Claude Code показывает
// текст агенту и просит исправить. Аргументы после имени скрипта передаются check-docs.mjs
// как есть (--dir, --strict, --enforced, --strict-coverage, --project): проект задаёт их
// в settings.json те же, что и в своей цепочке проверок.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const CHECK = path.resolve(import.meta.dirname, "..", "..", "scripts", "check-docs.mjs")
const args = process.argv.slice(2)

const dirs = []
for (let i = 0; i < args.length; i++) if (args[i] === "--dir") dirs.push(args[++i])
if (dirs.length === 0) dirs.push("docs/architecture/decisions", "docs/requirements", "docs/contracts")

let input = {}
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}")
} catch {
  process.exit(0)
}
const filePath = input.tool_input?.file_path
if (!filePath) process.exit(0)

const rel = path.relative(ROOT, path.resolve(input.cwd ?? ROOT, filePath)).replaceAll("\\", "/")
const inDocs = dirs.some((dir) => rel === dir || rel.startsWith(`${dir.replace(/\/$/, "")}/`))
if (!inDocs || !rel.endsWith(".md")) process.exit(0)

const result = spawnSync(process.execPath, [CHECK, ...args], { cwd: ROOT, encoding: "utf8" })
if (result.status === 0) process.exit(0)

const lines = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").filter(Boolean)
const shown = lines.slice(0, 20)
const more = lines.length > shown.length ? `\n  … и ещё ${lines.length - shown.length}` : ""
process.stderr.write(
  `Стандарт документов (docs/standards/README.md): после правки ${rel} проверка не прошла. Исправь сейчас:\n` +
    `${shown.map((line) => `  ${line}`).join("\n")}${more}\n` +
    `Индекс README пересобирается командой: node docs/standards/scripts/check-docs.mjs --write\n`,
)
process.exit(2)
