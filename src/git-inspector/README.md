# git-inspector

Importiert die Metadaten eines lokalen Git-Repositorys in eine neue oder bestehende SQLite-Datei. Gespeichert werden, wann und durch wen Commits entstanden sind und welche Dateien sie ändern. Commit-Nachrichten, Diffs und Dateiinhalte werden nicht gespeichert.

## Voraussetzungen

- Python **3.10 oder neuer**, ausschließlich Standardbibliothek.
- Git **2.38.0 oder neuer** im `PATH`. Git 2.38.0 erschien am 3. Oktober 2022 und führte den benötigten Modus `git merge-tree --write-tree` ein. Das Skript prüft die Version vor dem Import.
- Ein lokales Repository und ein vorhandenes Ausgabeverzeichnis. Kein automatischer Clone oder Fetch.
- UTF-8-Dateipfade und UTF-8-Git-Ausgabe. Nicht darstellbare Zeichen führen zum Abbruch statt zu verfälschten Pfaden.

Quellen: [Release Notes Git 2.38.0](https://github.com/git/git/blob/v2.38.0/Documentation/RelNotes/2.38.0.txt), [Release-Ankündigung](https://groups.google.com/g/git-packagers/c/Acce4SRDSXA), [merge-tree-Dokumentation](https://git-scm.com/docs/git-merge-tree).

## Aufruf

```bash
python3 src/git-inspector/git_inspector.py \
  --repo /pfad/zum/repository \
  --branch main \
  --output /pfad/zur/analyse.sqlite \
  --commits 1000 \
  --mode append
```

Alle fünf Parameter sind Pflicht. `--commits` muss eine positive Ganzzahl sein. Ein lokaler Branch hat Vorrang; `--branch origin/main` kann einen vorhandenen Remote-Tracking-Branch auswählen. Der Branch wird einmal zu einem Commit-Hash aufgelöst; die Untersuchung verwendet diesen festen Stand ohne Checkout.

`--repo` darf auch auf ein Unterverzeichnis des Repositorys zeigen. Als Schlüssel wird der absolute, aufgelöste Repository-Wurzelpfad verwendet. Bare-Repositories werden ebenfalls unterstützt. Ein verschobenes Repository gilt als neues Repository.

`--mode append` prüft die letzten N erreichbaren Commits und ergänzt noch nicht gespeicherte Commits. Es sucht nicht nach N unbekannten Commits. Bestehende Commit-Daten und Konfliktanalysen werden nicht neu berechnet. Der Gesamtbestand kann nach mehreren Aufrufen mehr als N Commits enthalten, auch aus mehreren Branches oder inzwischen umgeschriebener Historie.

`--mode replace` entfernt sämtliche Daten des gewählten Repositorys, einschließlich früherer Branch-Einträge und Konfliktanalysen, und importiert die ausgewählten N Commits neu. Andere Repositories und fremde Tabellen bleiben erhalten. Um Konfliktanalysen mit einer neuen Git-Version erneut zu berechnen, `replace` verwenden.

Die Auswahl erfolgt mit `git rev-list --topo-order --max-count=N`: eingebundene Nebenbranches zählen mit; N bezeichnet keine Zeitspanne. Merge-Commits zählen ebenfalls zum Limit. Flache Historien werden abgelehnt, wenn die Auswahl eine Shallow-Grenze erreicht, da dort Änderungen nicht zuverlässig bestimmt werden können.

Jeder Import läuft in einer SQLite-Transaktion. Fehler rollen Änderungen zurück. Bei einem fehlgeschlagenen Erstimport kann eine leere SQLite-Datei zurückbleiben. Bereits belegte Namen des Inspector-Schemas werden ohne passende Versionskennung abgelehnt. Exit-Code 0 bedeutet erfolgreicher Import; 1 bedeutet Laufzeitfehler und 2 ungültige CLI-Argumente. Eine erfolgreiche Ausführung meldet auch die Anzahl neu angelegter, unbekannter Merge-Analysen.

## Datenmodell

Alle Tabellen beginnen mit `git_`. Fremdschlüssel verbinden Commits über `(repository_id, hash)` beziehungsweise `(repository_id, commit_hash)`.

| Tabelle | Inhalt |
| --- | --- |
| `git_inspector_schema` | Schema-Version |
| `git_repositories` | Repository-ID und absoluter Pfad |
| `git_branches` | Je Branch zuletzt importierter Stand, Limit und Importzeit |
| `git_commits` | Hash, Autor/Committer mit Name, E-Mail und ISO-8601-Zeitstempeln samt Zeitzone; Elternanzahl und `is_merge` |
| `git_commit_parents` | Eltern-Hashes in Reihenfolge, Position beginnt bei 0; Eltern können außerhalb des Limits liegen |
| `git_file_changes` | Änderungsart, Pfad, optional alter Pfad und Ähnlichkeit bei Umbenennungen |
| `git_merge_analysis` | Rekonstruktionsstatus `clean`, `conflicts` oder `unknown`, Git-Version, Methode und gegebenenfalls Fehler |
| `git_merge_conflict_files` | Von Git gemeldete Dateipfade mit ungelösten Konfliktstufen |
| `git_merge_conflicts` | Konfliktarten der Rekonstruktion; mehrere Vorkommen möglich |
| `git_merge_conflict_paths` | Zuordnung einer Konfliktmeldung zu betroffenen Pfaden, soweit Git diese strukturiert liefert |

Die numerische Repository-ID ist ein interner Fremdschlüssel, kein CLI-Parameter. Namen und E-Mail-Adressen stammen aus den Commit-Metadaten, ohne Zusammenführung durch `.mailmap`. Autorzeit ist nicht zwingend die Zeit der tatsächlichen Bearbeitung. Es gibt keine Historie einzelner Skript-Aufrufe und keine gespeicherte Commit-Auswahl pro Branch. SQL-Abfragen über `git_commits` sehen den gesamten gesammelten Repository-Bestand.

Dateiänderungen werden für normale Commits gegen den Elterncommit, für den ersten Commit gegen den leeren Baum und für Merges gegen den **ersten Elterncommit** bestimmt. Änderungsarten sind unter anderem `A`, `M`, `D`, `R` und `T`. Umbenennungen ermittelt Git mit 50 % Ähnlichkeit; sie sind eine Heuristik. Es gibt keine durchgehende Dateiidentität über Umbenennungen. Binärdateien und Submodule werden als Pfadänderungen erfasst, ohne Inhalte beziehungsweise rekursiven Import.

## Merge-Konflikte

Für Merges mit zwei Eltern stellt das Skript deren Zusammenführung mit `git merge-tree --write-tree` nach. Die Ausgabe wird mit NUL-Trennzeichen gelesen, damit auch Leerzeichen, Tabs und Zeilenumbrüche in Dateinamen funktionieren. Temporäre Git-Objekte landen in einem temporären Verzeichnis, das danach entfernt wird. Arbeitsverzeichnis, Index, Branches und Objektspeicher des untersuchten Repositorys werden durch die Importbefehle nicht verändert.

Die Analyse kennzeichnet **nachträglich ermittelte Konflikte**. Sie beweist nicht, welche Konflikte damals tatsächlich auftraten oder wer sie löste. Git-Version, Attribute und Merge-Konfiguration können das Ergebnis beeinflussen. Der gespeicherte Committer bezeichnet die Person, die den Merge-Commit erstellt hat.

Merges mit mehr als zwei Eltern und fehlgeschlagene Rekonstruktionen erhalten `unknown`, niemals `clean`. Der Git-Exit-Code bestimmt den Konfliktstatus, da Konflikte auch ohne Einträge in der Liste einzelner Konfliktdateien möglich sind. Strukturierte Konfliktmeldungen können weitere betroffene Pfade enthalten, etwa bei Verzeichnisumbenennungen.

Unterstützt werden strukturierte Meldungen und ältere Textmeldungen. Bei Textmeldungen werden erkennbare Konfliktarten auf Merge-Ebene gespeichert; eine Zuordnung zu Dateipfaden wird nicht geraten. Inhalte und der freie Meldungstext werden nicht gespeichert.

## Beispielabfragen

Die Beispiele verwenden `:repo_id` als gebundenen SQL-Parameter. Die ID liefert `SELECT id, path FROM git_repositories`.

Häufig geänderte Dateien, ohne zusätzliche Zählung der Merges:

```sql
SELECT f.path, COUNT(*) AS changes
FROM git_file_changes AS f
JOIN git_commits AS c
  ON c.repository_id = f.repository_id AND c.hash = f.commit_hash
WHERE c.repository_id = :repo_id AND c.is_merge = 0
GROUP BY f.path
ORDER BY changes DESC;
```

Wer hat wann welche Dateien geändert:

```sql
SELECT c.authored_at, c.author_name, c.author_email,
       c.committer_name, c.committed_at, c.hash,
       f.change_type, f.old_path, f.path, c.is_merge
FROM git_commits AS c
JOIN git_file_changes AS f
  ON f.repository_id = c.repository_id AND f.commit_hash = c.hash
WHERE c.repository_id = :repo_id
ORDER BY julianday(c.authored_at) DESC;
```

Rekonstruierte Merge-Ergebnisse, einschließlich unbekannter Ergebnisse:

```sql
SELECT status, COUNT(*) AS merges
FROM git_merge_analysis
WHERE repository_id = :repo_id
GROUP BY status;
```

Dateien mit rekonstruierten Konflikten, inklusive Pfaden aus strukturierten Meldungen:

```sql
WITH paths AS (
  SELECT repository_id, commit_hash, path FROM git_merge_conflict_files
  UNION
  SELECT repository_id, commit_hash, path FROM git_merge_conflict_paths
)
SELECT path, COUNT(*) AS merges_with_conflicts
FROM paths
WHERE repository_id = :repo_id
GROUP BY path
ORDER BY merges_with_conflicts DESC;
```

## Tests

Mit Git >= 2.38.0 im `PATH`:

```bash
cd src/git-inspector
python3 -m unittest -v
```

Die Tests erstellen ausschließlich temporäre Repositories und SQLite-Dateien. Sie prüfen unter anderem Ergänzen ohne Duplikate, Ersetzen mit Erhalt fremder Daten, Rollback, Metadaten, Umbenennungen, ungewöhnliche Dateinamen sowie konfliktfreie und konfliktbehaftete Merges. Beim Konfliktimport werden außerdem Arbeitsverzeichnis, Index und Objektspeicher auf Veränderungen geprüft.
