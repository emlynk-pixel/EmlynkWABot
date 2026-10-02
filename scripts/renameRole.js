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

let updatedCount = 0;
for (const file of filesToUpdate) {
    let content = fs.readFileSync(file, 'utf8');
    
    if (content.includes('ANALYST') || content.includes('Analyst') || content.includes('analyst')) {
        // We only want to replace ANALYST where it's a role. 
        // We do a regex replace to be safe.
        // Replace ANALYST -> ANALYST
        let newContent = content.replace(/ANALYST/g, 'ANALYST');
        // Replace Analyst -> Analyst
        newContent = newContent.replace(/Analyst/g, 'Analyst');
        // analyst -> analyst (except in file paths or variable names if possible, but global replace is fine for this project context)
        newContent = newContent.replace(/analyst/g, 'analyst');
        
        // Wait, for InvitationsPage.tsx we need specific label changes. We'll handle it separately or let this pass and then overwrite it.
        
        if (content !== newContent) {
            fs.writeFileSync(file, newContent, 'utf8');
            updatedCount++;
            console.log(`Updated ${file}`);
        }
    }
}
console.log(`Updated ${updatedCount} files.`);

// Update database
async function updateDb() {
    const prisma = new PrismaClient();
    try {
        console.log("Updating database records...");
        
        const adminUpdate = await prisma.admin.updateMany({
            where: { role: 'ANALYST' },
            data: { role: 'ANALYST' }
        });
        console.log(`Updated ${adminUpdate.count} Admin records.`);

        const invUpdate = await prisma.adminInvitation.updateMany({
            where: { role: 'ANALYST' },
            data: { role: 'ANALYST' }
        });
        console.log(`Updated ${invUpdate.count} AdminInvitation records.`);

        console.log("Database update complete.");
    } catch (e) {
        console.error("Failed to update DB:", e);
    } finally {
        await prisma.$disconnect();
    }
}

updateDb();
