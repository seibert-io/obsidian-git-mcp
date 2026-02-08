# Such-Strategie im Vault

## Notiz nach Titel finden
→ search_files mit pattern: "*suchbegriff*.md"

## Inhalt durchsuchen (Volltextsuche)
→ grep mit query, ggf. include_pattern: "*.md"

## Alle Notizen mit bestimmtem Tag
→ grep mit query: "#tagname" oder query: "tags:.*tagname"

## Alle Backlinks zu einer Notiz
→ get_backlinks (dediziertes Tool)

## Notizen aus einem Zeitraum
→ find_files mit modified_after / modified_before

## Vault-Überblick verschaffen
→ get_vault_info, dann list_directory auf relevante Ordner

## Kombinierte Suche
Oft sind mehrere Tools nacheinander sinnvoll:
1. search_files um Kandidaten zu finden
2. read_file um Inhalt zu prüfen
3. get_backlinks um Kontext zu verstehen
