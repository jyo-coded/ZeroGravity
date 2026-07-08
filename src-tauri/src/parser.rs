//! Language-specific code parser — extracts imports, function definitions,
//! and type definitions from source files using regex patterns.
//!
//! Used by the CodeGraph to build structural relationships between files.
//! Supports: TypeScript/JavaScript, Rust, Python, Go.
//! All other extensions return an empty ParsedFile (file node only, no edges).

use regex::Regex;
use std::collections::HashSet;
use std::path::Path;

// ─── Output types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FunctionDef {
    pub name: String,
    pub line: u32,
}

#[derive(Debug, Clone)]
pub struct TypeDef {
    pub name: String,
    /// "class" | "struct" | "interface" | "enum" | "trait" | "type" | "impl"
    pub kind: String,
    pub line: u32,
}

#[derive(Debug, Clone)]
pub struct ParsedFile {
    /// Raw import paths exactly as written in source (may be relative or a module name)
    pub raw_imports: Vec<String>,
    pub functions: Vec<FunctionDef>,
    pub types: Vec<TypeDef>,
}

impl ParsedFile {
    pub fn empty() -> Self {
        Self {
            raw_imports: vec![],
            functions: vec![],
            types: vec![],
        }
    }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/// T0-2: tree-sitter first (accurate — catches impl methods, class methods,
/// nested definitions the regexes miss), regex as the resilient fallback.
pub fn parse_file(path: &str, content: &str) -> ParsedFile {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    if let Some(parsed) = ts_impl::parse(ext, content) {
        return parsed;
    }

    match ext {
        "ts" | "tsx" | "js" | "jsx" => parse_typescript(content),
        "rs" => parse_rust(content),
        "py" => parse_python(content),
        "go" => parse_go(content),
        _ => ParsedFile::empty(),
    }
}

// ─── Tree-sitter engine (T0-2) ────────────────────────────────────────────────

mod ts_impl {
    use super::{FunctionDef, ParsedFile, TypeDef};
    use tree_sitter::{Language, Node, Parser};

    #[derive(Clone, Copy)]
    enum Flavor {
        Rust,
        Ts,
        Py,
        Go,
    }

    pub fn parse(ext: &str, content: &str) -> Option<ParsedFile> {
        let (lang, flavor): (Language, Flavor) = match ext {
            "rs" => (tree_sitter_rust::LANGUAGE.into(), Flavor::Rust),
            "ts" => (tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), Flavor::Ts),
            "tsx" => (tree_sitter_typescript::LANGUAGE_TSX.into(), Flavor::Ts),
            "js" | "jsx" => (tree_sitter_javascript::LANGUAGE.into(), Flavor::Ts),
            "py" => (tree_sitter_python::LANGUAGE.into(), Flavor::Py),
            "go" => (tree_sitter_go::LANGUAGE.into(), Flavor::Go),
            _ => return None,
        };
        let mut parser = Parser::new();
        parser.set_language(&lang).ok()?;
        let tree = parser.parse(content, None)?;
        let mut out = ParsedFile::empty();
        walk(tree.root_node(), content.as_bytes(), flavor, &mut out);
        Some(out)
    }

    fn text<'a>(n: Node, src: &'a [u8]) -> &'a str {
        n.utf8_text(src).unwrap_or("")
    }
    fn name_of(n: Node, src: &[u8]) -> Option<String> {
        n.child_by_field_name("name").map(|c| text(c, src).to_string())
    }
    fn line(n: Node) -> u32 {
        n.start_position().row as u32 + 1
    }
    fn strip_quotes(s: &str) -> String {
        s.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()
    }

    fn walk(node: Node, src: &[u8], flavor: Flavor, out: &mut ParsedFile) {
        let kind = node.kind();
        match flavor {
            Flavor::Rust => match kind {
                "function_item" => {
                    if let Some(n) = name_of(node, src) {
                        out.functions.push(FunctionDef { name: n, line: line(node) });
                    }
                }
                "struct_item" | "enum_item" | "trait_item" => {
                    if let Some(n) = name_of(node, src) {
                        let k = kind.trim_end_matches("_item");
                        out.types.push(TypeDef { name: n, kind: k.into(), line: line(node) });
                    }
                }
                "impl_item" => {
                    if let Some(t) = node.child_by_field_name("type") {
                        out.types.push(TypeDef {
                            name: text(t, src).to_string(),
                            kind: "impl".into(),
                            line: line(node),
                        });
                    }
                }
                "use_declaration" => {
                    if let Some(a) = node.child_by_field_name("argument") {
                        out.raw_imports.push(text(a, src).trim_end_matches(';').to_string());
                    }
                }
                "mod_item" => {
                    // `mod x;` without a body points at a sibling module file
                    if node.child_by_field_name("body").is_none() {
                        if let Some(n) = name_of(node, src) {
                            out.raw_imports.push(format!("mod:{}", n));
                        }
                    }
                }
                _ => {}
            },
            Flavor::Ts => match kind {
                "import_statement" => {
                    if let Some(s) = node.child_by_field_name("source") {
                        out.raw_imports.push(strip_quotes(text(s, src)));
                    }
                }
                "function_declaration" | "generator_function_declaration" => {
                    if let Some(n) = name_of(node, src) {
                        out.functions.push(FunctionDef { name: n, line: line(node) });
                    }
                }
                "method_definition" => {
                    if let Some(n) = name_of(node, src) {
                        out.functions.push(FunctionDef { name: n, line: line(node) });
                    }
                }
                "class_declaration" | "abstract_class_declaration" => {
                    if let Some(n) = name_of(node, src) {
                        out.types.push(TypeDef { name: n, kind: "class".into(), line: line(node) });
                    }
                }
                "interface_declaration" => {
                    if let Some(n) = name_of(node, src) {
                        out.types.push(TypeDef { name: n, kind: "interface".into(), line: line(node) });
                    }
                }
                "type_alias_declaration" => {
                    if let Some(n) = name_of(node, src) {
                        out.types.push(TypeDef { name: n, kind: "type".into(), line: line(node) });
                    }
                }
                "enum_declaration" => {
                    if let Some(n) = name_of(node, src) {
                        out.types.push(TypeDef { name: n, kind: "enum".into(), line: line(node) });
                    }
                }
                "variable_declarator" => {
                    // const foo = () => … / const foo = function …
                    let is_fn = node
                        .child_by_field_name("value")
                        .map(|v| matches!(v.kind(), "arrow_function" | "function_expression" | "function"))
                        .unwrap_or(false);
                    if is_fn {
                        if let Some(n) = name_of(node, src) {
                            out.functions.push(FunctionDef { name: n, line: line(node) });
                        }
                    }
                }
                _ => {}
            },
            Flavor::Py => match kind {
                "function_definition" => {
                    if let Some(n) = name_of(node, src) {
                        out.functions.push(FunctionDef { name: n, line: line(node) });
                    }
                }
                "class_definition" => {
                    if let Some(n) = name_of(node, src) {
                        out.types.push(TypeDef { name: n, kind: "class".into(), line: line(node) });
                    }
                }
                "import_statement" => {
                    let mut c = node.walk();
                    for ch in node.named_children(&mut c) {
                        match ch.kind() {
                            "dotted_name" => out.raw_imports.push(text(ch, src).to_string()),
                            "aliased_import" => {
                                if let Some(n) = ch.child_by_field_name("name") {
                                    out.raw_imports.push(text(n, src).to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "import_from_statement" => {
                    if let Some(m) = node.child_by_field_name("module_name") {
                        out.raw_imports.push(text(m, src).to_string());
                    }
                }
                _ => {}
            },
            Flavor::Go => match kind {
                "function_declaration" | "method_declaration" => {
                    if let Some(n) = name_of(node, src) {
                        out.functions.push(FunctionDef { name: n, line: line(node) });
                    }
                }
                "type_spec" => {
                    if let Some(n) = name_of(node, src) {
                        out.types.push(TypeDef { name: n, kind: "type".into(), line: line(node) });
                    }
                }
                "import_spec" => {
                    if let Some(p) = node.child_by_field_name("path") {
                        out.raw_imports.push(strip_quotes(text(p, src)));
                    }
                }
                _ => {}
            },
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            walk(child, src, flavor, out);
        }
    }
}

// ─── TypeScript / JavaScript ──────────────────────────────────────────────────

fn parse_typescript(content: &str) -> ParsedFile {
    // Matches: import ... from 'path'   AND   import 'side-effect'
    let from_re = Regex::new(r#"from\s+['"]([^'"]+)['"]"#).unwrap();
    let side_re = Regex::new(r#"^\s*import\s+['"]([^'"]+)['"]"#).unwrap();

    // Functions: regular, async, exported, default exported
    let fn_re =
        Regex::new(r"(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]").unwrap();
    // Arrow / assigned functions: const foo = () => or const foo = async () =>
    let arrow_re =
        Regex::new(r"(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(").unwrap();

    let class_re = Regex::new(r"(?:export\s+)?(?:abstract\s+)?class\s+(\w+)").unwrap();
    let iface_re = Regex::new(r"(?:export\s+)?interface\s+(\w+)").unwrap();
    // type Foo = ... or type Foo<T> = ...
    let type_re = Regex::new(r"(?:export\s+)?type\s+(\w+)\s*[=<]").unwrap();
    let enum_re = Regex::new(r"(?:export\s+)?(?:const\s+)?enum\s+(\w+)").unwrap();

    let mut raw_imports = vec![];
    let mut functions = vec![];
    let mut types = vec![];

    for (ln0, line) in content.lines().enumerate() {
        let ln = (ln0 + 1) as u32;

        // Imports
        for cap in from_re.captures_iter(line) {
            if let Some(m) = cap.get(1) {
                raw_imports.push(m.as_str().to_string());
            }
        }
        if let Some(cap) = side_re.captures(line) {
            if let Some(m) = cap.get(1) {
                raw_imports.push(m.as_str().to_string());
            }
        }

        // Functions — prefer fn_re, fall back to arrow_re
        if let Some(cap) = fn_re.captures(line) {
            if let Some(m) = cap.get(1) {
                functions.push(FunctionDef {
                    name: m.as_str().to_string(),
                    line: ln,
                });
            }
        } else if let Some(cap) = arrow_re.captures(line) {
            if let Some(m) = cap.get(1) {
                functions.push(FunctionDef {
                    name: m.as_str().to_string(),
                    line: ln,
                });
            }
        }

        // Types
        if let Some(cap) = class_re.captures(line) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "class".into(),
                    line: ln,
                });
            }
        } else if let Some(cap) = iface_re.captures(line) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "interface".into(),
                    line: ln,
                });
            }
        } else if let Some(cap) = type_re.captures(line) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "type".into(),
                    line: ln,
                });
            }
        } else if let Some(cap) = enum_re.captures(line) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "enum".into(),
                    line: ln,
                });
            }
        }
    }

    ParsedFile {
        raw_imports,
        functions,
        types,
    }
}

// ─── Rust ─────────────────────────────────────────────────────────────────────

fn parse_rust(content: &str) -> ParsedFile {
    // `use` paths are module paths, not file paths — we capture them but they
    // won't resolve to local files (Rust module system ≠ filesystem 1:1).
    // Still useful to record crate::module relationships in the graph summary.
    let use_re = Regex::new(r"^\s*(?:pub\s+)?use\s+([\w:]+)").unwrap();
    let fn_re = Regex::new(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[(<]").unwrap();
    let struct_re = Regex::new(r"^\s*(?:pub\s+)?struct\s+(\w+)").unwrap();
    let enum_re = Regex::new(r"^\s*(?:pub\s+)?enum\s+(\w+)").unwrap();
    let trait_re = Regex::new(r"^\s*(?:pub\s+)?trait\s+(\w+)").unwrap();
    let impl_re = Regex::new(r"^\s*impl(?:<[^>]+>)?\s+(\w+)").unwrap();

    let mut raw_imports = vec![];
    let mut functions = vec![];
    let mut types = vec![];

    for (ln0, line) in content.lines().enumerate() {
        let ln = (ln0 + 1) as u32;

        if let Some(cap) = use_re.captures(line) {
            if let Some(m) = cap.get(1) {
                raw_imports.push(m.as_str().to_string());
            }
        }
        if let Some(cap) = fn_re.captures(line) {
            if let Some(m) = cap.get(1) {
                functions.push(FunctionDef {
                    name: m.as_str().to_string(),
                    line: ln,
                });
            }
        }
        if let Some(cap) = struct_re.captures(line) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "struct".into(),
                    line: ln,
                });
            }
        } else if let Some(cap) = enum_re.captures(line) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "enum".into(),
                    line: ln,
                });
            }
        } else if let Some(cap) = trait_re.captures(line) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "trait".into(),
                    line: ln,
                });
            }
        } else if let Some(cap) = impl_re.captures(line) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "impl".into(),
                    line: ln,
                });
            }
        }
    }

    ParsedFile {
        raw_imports,
        functions,
        types,
    }
}

// ─── Python ───────────────────────────────────────────────────────────────────

fn parse_python(content: &str) -> ParsedFile {
    let from_re = Regex::new(r"^from\s+([\w.]+)\s+import").unwrap();
    let imp_re = Regex::new(r"^import\s+([\w.,\s]+)").unwrap();
    let fn_re = Regex::new(r"^(?:async\s+)?def\s+(\w+)\s*\(").unwrap();
    let class_re = Regex::new(r"^class\s+(\w+)").unwrap();

    let mut raw_imports = vec![];
    let mut functions = vec![];
    let mut types = vec![];

    for (ln0, line) in content.lines().enumerate() {
        let ln = (ln0 + 1) as u32;
        let trimmed = line.trim();

        if let Some(cap) = from_re.captures(trimmed) {
            if let Some(m) = cap.get(1) {
                raw_imports.push(m.as_str().to_string());
            }
        } else if let Some(cap) = imp_re.captures(trimmed) {
            if let Some(m) = cap.get(1) {
                for part in m.as_str().split(',') {
                    let name = part
                        .trim()
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .to_string();
                    if !name.is_empty() {
                        raw_imports.push(name);
                    }
                }
            }
        }

        if let Some(cap) = fn_re.captures(trimmed) {
            if let Some(m) = cap.get(1) {
                functions.push(FunctionDef {
                    name: m.as_str().to_string(),
                    line: ln,
                });
            }
        }
        if let Some(cap) = class_re.captures(trimmed) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "class".into(),
                    line: ln,
                });
            }
        }
    }

    ParsedFile {
        raw_imports,
        functions,
        types,
    }
}

// ─── Go ───────────────────────────────────────────────────────────────────────

fn parse_go(content: &str) -> ParsedFile {
    let str_re = Regex::new(r#""([^"]+)""#).unwrap();
    let fn_re = Regex::new(r"^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(").unwrap();
    let type_re = Regex::new(r"^type\s+(\w+)\s+(?:struct|interface)").unwrap();

    let mut raw_imports = vec![];
    let mut functions = vec![];
    let mut types = vec![];
    let mut in_import_block = false;

    for (ln0, line) in content.lines().enumerate() {
        let ln = (ln0 + 1) as u32;
        let trimmed = line.trim();

        if trimmed == "import (" {
            in_import_block = true;
            continue;
        }
        if in_import_block {
            if trimmed == ")" {
                in_import_block = false;
                continue;
            }
            for cap in str_re.captures_iter(trimmed) {
                if let Some(m) = cap.get(1) {
                    raw_imports.push(m.as_str().to_string());
                }
            }
            continue;
        }
        if trimmed.starts_with("import ") {
            for cap in str_re.captures_iter(trimmed) {
                if let Some(m) = cap.get(1) {
                    raw_imports.push(m.as_str().to_string());
                }
            }
        }

        if let Some(cap) = fn_re.captures(trimmed) {
            if let Some(m) = cap.get(1) {
                functions.push(FunctionDef {
                    name: m.as_str().to_string(),
                    line: ln,
                });
            }
        }
        if let Some(cap) = type_re.captures(trimmed) {
            if let Some(m) = cap.get(1) {
                types.push(TypeDef {
                    name: m.as_str().to_string(),
                    kind: "type".into(),
                    line: ln,
                });
            }
        }
    }

    ParsedFile {
        raw_imports,
        functions,
        types,
    }
}

// ─── Import path resolution ───────────────────────────────────────────────────

/// Try to resolve a raw import string to an actual file path that exists in
/// the project's `known_files` set.
///
/// Only resolves *relative* imports (starting with `.` or `/`). External
/// module names (e.g. `"react"`, `"tokio"`) are intentionally skipped.
///
/// Tries common extension variants: `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, etc.
pub fn resolve_import(
    raw_import: &str,
    importing_file: &str,
    known_files: &HashSet<String>,
) -> Option<String> {
    // T0-2: Rust `mod x;` declarations — sibling file or dir module
    if let Some(name) = raw_import.strip_prefix("mod:") {
        let dir = parent_dir(importing_file);
        let candidates = [
            join_dir(&dir, &format!("{}.rs", name)),
            join_dir(&dir, &format!("{}/mod.rs", name)),
        ];
        return candidates
            .into_iter()
            .find(|c| known_files.contains(c.as_str()));
    }

    // T0-2: Rust use-paths (crate:: / super:: / self:: / bare local module)
    if importing_file.ends_with(".rs")
        && (raw_import.contains("::")
            || raw_import.starts_with("crate")
            || raw_import.starts_with("super")
            || raw_import.starts_with("self"))
    {
        return resolve_rust_use(raw_import, importing_file, known_files);
    }

    // T0-2: Python dotted / relative imports
    if importing_file.ends_with(".py") {
        return resolve_python_import(raw_import, importing_file, known_files);
    }

    // Skip external / absolute module names
    if !raw_import.starts_with('.') && !raw_import.starts_with('/') {
        return None;
    }

    let dir = Path::new(importing_file)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    let joined = if dir.is_empty() {
        raw_import.to_string()
    } else {
        format!("{}/{}", dir, raw_import)
    };

    let base = normalize_path(&joined);

    // Try bare path first, then common extensions
    let candidates = [
        base.clone(),
        format!("{}.ts", base),
        format!("{}.tsx", base),
        format!("{}.js", base),
        format!("{}.jsx", base),
        format!("{}/index.ts", base),
        format!("{}/index.tsx", base),
        format!("{}/index.js", base),
    ];

    for candidate in &candidates {
        if known_files.contains(candidate.as_str()) {
            return Some(candidate.clone());
        }
    }

    None
}

fn parent_dir(file: &str) -> String {
    Path::new(file)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn join_dir(dir: &str, rest: &str) -> String {
    if dir.is_empty() {
        rest.to_string()
    } else {
        format!("{}/{}", dir, rest)
    }
}

/// Resolve a Rust `use` path to a project file: walks the module path from
/// the crate's src root (crate::), the parent dir (super::), or the file's
/// own dir (self:: / bare module), trying `{p}.rs` and `{p}/mod.rs` from the
/// deepest segment prefix down. External crates simply never match.
fn resolve_rust_use(
    raw: &str,
    importing_file: &str,
    known_files: &HashSet<String>,
) -> Option<String> {
    // Strip braces/globs: "crate::{a, b}" or "x::*" — take the part before '{' or '*'
    let cleaned = raw.split(['{', '*']).next().unwrap_or(raw).trim_end_matches("::").trim();
    let segs: Vec<&str> = cleaned.split("::").map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return None;
    }

    let file_dir = parent_dir(importing_file);
    let (base, rest): (String, &[&str]) = match segs[0] {
        "crate" => {
            // src root = path up to and including the last "src" component
            let parts: Vec<&str> = importing_file.split('/').collect();
            let src_idx = parts.iter().rposition(|p| *p == "src");
            let base = src_idx
                .map(|i| parts[..=i].join("/"))
                .unwrap_or_default();
            (base, &segs[1..])
        }
        "super" => {
            let mut d = file_dir.clone();
            let mut i = 0;
            while segs.get(i) == Some(&"super") {
                d = parent_dir(&d);
                i += 1;
            }
            (d, &segs[i..])
        }
        "self" => (file_dir.clone(), &segs[1..]),
        _ => (file_dir.clone(), &segs[..]),
    };

    if rest.is_empty() {
        return None;
    }

    // Deepest prefix first — trailing segments are items, not modules
    for take in (1..=rest.len()).rev() {
        let p = rest[..take].join("/");
        for cand in [join_dir(&base, &format!("{}.rs", p)), join_dir(&base, &format!("{}/mod.rs", p))] {
            if known_files.contains(cand.as_str()) && cand != importing_file {
                return Some(cand);
            }
        }
    }
    None
}

/// Resolve Python `import a.b` / `from .x import y` to project files.
fn resolve_python_import(
    raw: &str,
    importing_file: &str,
    known_files: &HashSet<String>,
) -> Option<String> {
    let dots = raw.chars().take_while(|c| *c == '.').count();
    let rest = &raw[dots..];
    let path_part = rest.replace('.', "/");

    let mut candidates: Vec<String> = vec![];
    if dots > 0 {
        // Relative: one dot = same package dir, each extra dot climbs one level
        let mut base = parent_dir(importing_file);
        for _ in 1..dots {
            base = parent_dir(&base);
        }
        if path_part.is_empty() {
            candidates.push(join_dir(&base, "__init__.py"));
        } else {
            candidates.push(join_dir(&base, &format!("{}.py", path_part)));
            candidates.push(join_dir(&base, &format!("{}/__init__.py", path_part)));
        }
    } else {
        if path_part.is_empty() {
            return None;
        }
        // Absolute: project root, then the importing file's own dir
        candidates.push(format!("{}.py", path_part));
        candidates.push(format!("{}/__init__.py", path_part));
        let dir = parent_dir(importing_file);
        candidates.push(join_dir(&dir, &format!("{}.py", path_part)));
        candidates.push(join_dir(&dir, &format!("{}/__init__.py", path_part)));
    }

    candidates
        .into_iter()
        .find(|c| known_files.contains(c.as_str()) && c != importing_file)
}

/// Collapse `.` and `..` segments in a `/`-separated path string.
fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = vec![];
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ts_imports() {
        let src = r#"
import { useState } from 'react'
import type { Foo } from './types'
import api from '../lib/api'
import './styles.css'
"#;
        let p = parse_typescript(src);
        assert!(p.raw_imports.contains(&"react".to_string()));
        assert!(p.raw_imports.contains(&"./types".to_string()));
        assert!(p.raw_imports.contains(&"../lib/api".to_string()));
        assert!(p.raw_imports.contains(&"./styles.css".to_string()));
    }

    #[test]
    fn test_ts_functions() {
        let src = r#"
export function greet(name: string) {}
const add = (a: number, b: number) => a + b
export async function fetchData() {}
"#;
        let p = parse_typescript(src);
        let names: Vec<_> = p.functions.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"greet"));
        assert!(names.contains(&"add"));
        assert!(names.contains(&"fetchData"));
    }

    #[test]
    fn test_resolve_import() {
        let mut known = HashSet::new();
        known.insert("src/lib/api.ts".to_string());

        let resolved = resolve_import("../lib/api", "src/components/App.tsx", &known);
        assert_eq!(resolved, Some("src/lib/api.ts".to_string()));
    }

    #[test]
    fn test_rust_functions() {
        let src = r#"
pub async fn handle_request(req: Request) -> Response {}
fn internal_helper() {}
pub struct MyStruct {}
"#;
        let p = parse_rust(src);
        let fn_names: Vec<_> = p.functions.iter().map(|f| f.name.as_str()).collect();
        assert!(fn_names.contains(&"handle_request"));
        assert!(fn_names.contains(&"internal_helper"));
        let type_names: Vec<_> = p.types.iter().map(|t| t.name.as_str()).collect();
        assert!(type_names.contains(&"MyStruct"));
    }
}
