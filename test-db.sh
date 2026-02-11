#!/bin/bash
# Test script to verify database operations work correctly
# This helps identify if issues are in the database layer or UI

set -e

echo "=== GSD Demo Database Test ==="
echo

# Get the database location
if [ "$(uname)" = "Linux" ]; then
    DB_PATH="$HOME/.local/share/gsd-demo/gsd-demo.db"
elif [ "$(uname)" = "Darwin" ]; then
    DB_PATH="$HOME/Library/Application Support/gsd-demo/gsd-demo.db"
else
    DB_PATH="$APPDATA/gsd-demo/gsd-demo.db"
fi

echo "Database location: $DB_PATH"
echo

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
    echo "❌ Database does not exist"
    echo "   The app hasn't been run yet, or database creation failed"
    exit 1
fi

echo "✓ Database file exists"
echo

# Check database is readable
if ! sqlite3 "$DB_PATH" "SELECT 1" >/dev/null 2>&1; then
    echo "❌ Database is not readable (corrupted or permissions issue)"
    exit 1
fi

echo "✓ Database is readable"
echo

# Check schema version
echo "--- Schema Version ---"
SCHEMA_VERSION=$(sqlite3 "$DB_PATH" "PRAGMA user_version" 2>&1 || echo "ERROR")
if [ "$SCHEMA_VERSION" = "ERROR" ]; then
    echo "❌ Cannot read schema version"
    exit 1
fi
echo "Schema version: $SCHEMA_VERSION"
echo

# Check tables exist
echo "--- Tables ---"
TABLES=$(sqlite3 "$DB_PATH" ".tables" 2>&1 || echo "ERROR")
if [ "$TABLES" = "ERROR" ]; then
    echo "❌ Cannot list tables"
    exit 1
fi
echo "$TABLES"
echo

# Check settings table
echo "--- Settings ---"
SETTINGS=$(sqlite3 "$DB_PATH" "SELECT key, value FROM settings" 2>&1 || echo "ERROR")
if [ "$SETTINGS" = "ERROR" ]; then
    echo "❌ Cannot read settings"
    exit 1
fi

if [ -z "$SETTINGS" ]; then
    echo "(No settings saved yet)"
else
    echo "$SETTINGS" | while IFS='|' read -r key value; do
        echo "  $key: $value"
    done
fi
echo

# Check projects table
echo "--- Projects ---"
PROJECTS=$(sqlite3 "$DB_PATH" "SELECT id, name, path, created_at FROM projects ORDER BY created_at DESC" 2>&1 || echo "ERROR")
if [ "$PROJECTS" = "ERROR" ]; then
    echo "❌ Cannot read projects"
    exit 1
fi

if [ -z "$PROJECTS" ]; then
    echo "(No projects yet)"
else
    PROJECT_COUNT=$(echo "$PROJECTS" | wc -l)
    echo "Found $PROJECT_COUNT project(s):"
    echo "$PROJECTS" | while IFS='|' read -r id name path created_at; do
        echo "  [$id] $name"
        echo "      Path: $path"
        echo "      Created: $created_at"
    done
fi
echo

# Check tasks table
echo "--- Tasks ---"
TASKS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks" 2>&1 || echo "ERROR")
if [ "$TASKS" = "ERROR" ]; then
    echo "❌ Cannot read tasks"
    exit 1
fi
echo "Total tasks: $TASKS"
echo

echo "=== Test Summary ==="
echo "✓ Database operational"
echo "✓ All tables accessible"
echo "  Projects: $(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM projects")"
echo "  Tasks: $(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks")"
echo "  Settings keys: $(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM settings")"
echo

echo "To manually test project creation:"
echo "  sqlite3 \"$DB_PATH\" \"INSERT INTO projects (name, path, created_at, updated_at, is_remote) VALUES ('test', '/tmp/test', datetime('now'), datetime('now'), 0); SELECT * FROM projects WHERE name='test';\""
