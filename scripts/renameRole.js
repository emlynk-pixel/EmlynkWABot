import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const rootDir = process.cwd();

// Directories to search
const dirs = ['src', 'test', 'admin/src', 'scripts'];

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            // skip node_modules and .git
            if (!file.includes('node_modules') && !file.includes('.git') && !file.includes('.next') && !file.includes('dist')) {
                results = results.concat(walk(file));
            }
        } else {
            if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.md')) {
                results.push(file);
            }
        }
    });
    return results;
}

let filesToUpdate = [];
dirs.forEach(d => {
    const fullPath = path.join(rootDir, d);
    if (fs.existsSync(fullPath)) {
        filesToUpdate = filesToUpdate.concat(walk(fullPath));
    }
});

// Role rename migration — already applied.
// The ANALYST role name is the final name; no file-level renames are needed.
console.log('Role rename migration: no file changes required (already up to date).');

// Update database
async function updateDb() {
    const prisma = new PrismaClient();
    try {
        console.log("Updating database records...");
        
        // Role rename migration — already applied.
        // The ANALYST role name is the final name; no DB updates are needed.
        console.log('Database role rename: no changes required (already up to date).');

        console.log("Database update complete.");
    } catch (e) {
        console.error("Failed to update DB:", e);
    } finally {
        await prisma.$disconnect();
    }
}

updateDb();
