# Obsidian Vault Conventions

## Links
- Interne Links: [[Notiztitel]] oder [[Notiztitel|Anzeigename]]
- Heading-Links: [[Notiztitel#Heading]]
- Block-Links: [[Notiztitel#^block-id]]
- Embeds: ![[Notiztitel]] bettet die Notiz inline ein
- Verwende IMMER Wikilinks ([[...]]), keine Markdown-Links ([...](...))

## Frontmatter (YAML)
Jede Notiz kann YAML-Frontmatter haben:
---
title: Titel der Notiz
tags: [tag1, tag2]
aliases: [Alternativname]
date: 2025-01-15
---

## Tags
- Inline-Tags: #tag oder #parent/child (verschachtelt)
- Frontmatter-Tags: tags: [tag1, tag2]
- Beides wird von Obsidian erkannt

## Callouts
> [!note] Titel
> Inhalt

Typen: note, tip, warning, danger, info, question, quote, example, bug, success, failure, abstract

## Dateipfade
- Alle Pfade relativ zum Vault-Root
- Ordner mit / getrennt
- Dateiendung .md für Notizen

## Daily Notes
- Übliches Format: YYYY-MM-DD.md
- Üblicher Ordner: daily/ oder journal/

## Dataview
Viele Vaults nutzen das Dataview-Plugin. Inline-Felder:
key:: value

## CLAUDE.md Instruktionen
Dieser Vault kann CLAUDE.md-Dateien enthalten, die dir spezifische Anweisungen geben:

- **Root-CLAUDE.md** (im Vault-Root): Wird automatisch bei Session-Start über die Server-Instructions geliefert. Du hast diese Anweisungen bereits erhalten, falls eine solche Datei existiert.
- **Unterordner-CLAUDE.md**: Verzeichnisse können eigene CLAUDE.md-Dateien mit ordnerspezifischen Konventionen enthalten (z.B. Namenskonventionen, Vorlagen, Arbeitsweisen).

**Wichtig:** Bevor du in einem bestimmten Unterordner arbeitest oder eine Datei in einem Unterordner liest/bearbeitest, rufe `get_claude_context` mit dem jeweiligen Verzeichnispfad auf, um ordnerspezifische Anweisungen zu laden. Beispiel: Vor der Arbeit in `projects/webapp/` → `get_claude_context` mit path `projects/webapp`.

## Best Practices
- Atomare Notizen: eine Idee pro Notiz
- Aussagekräftige Titel (werden als Link-Text verwendet)
- Verlinkungen großzügig setzen — sie sind der Kern von Obsidian
- Tags für Kategorisierung, Links für Beziehungen
- Frontmatter für maschinenlesbare Metadaten
