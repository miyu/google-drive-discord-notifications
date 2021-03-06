const config = require('../config/default')
const Bluebird = require('bluebird')
const fs = require('fs')
const JsDiff = require('diff')
Bluebird.promisifyAll(fs)

// discord stuff
const Discord = require('discord.js');
const discordHook = new Discord.WebhookClient(config.discord.webhookId, config.discord.webhookToken);

// drive stuff
const DriveAuth = require('./DriveAuth')
const DriveApi = require('./DriveApi')

// Send a message using the webhook
async function init() {
    if (fs.existsSync(config.drive.lastPageTokenStorePath)) {
        console.log(`Found ${config.drive.lastPageTokenStorePath} - not pulling all files again.`)
        return;
    }
    console.log(`Didn't find ${config.drive.lastPageTokenStorePath} - pulling all files again.`)
    fs.writeFileAsync(config.drive.lastPageTokenStorePath, (await DriveApi.changesGetStartPageToken()).startPageToken)

    let includeTeamDriveItems = true;
    let supportsTeamDrives = true;
    for (let teamDriveId of config.drive.teamDriveIds) {
        let pageToken = null;
        const makeRequest = () => DriveApi.filesList({pageToken, pageSize: 10, corpora: 'teamDrive', spaces: 'drive', includeTeamDriveItems, supportsTeamDrives, teamDriveId});
        let res = await makeRequest()
        console.log(JSON.stringify(res))
        while (true) {
            for (const file of res.files) {
                if (file.kind != 'drive#file') continue;
                if (file.mimeType != 'application/vnd.google-apps.document') continue;

                const headStoreFilePath = config.drive.headStorePath + '/' + file.id + '.txt'
                const nameStoreFilePath = config.drive.nameStorePath + '/' + file.id + '.txt'
                if (!fs.existsSync(headStoreFilePath)) {
                    console.log(`Init: fetch ${file.name} (${file.id}).`)
                    const content = await DriveApi.fetchDocsFileAsString(file.id);
                    await fs.writeFileAsync(headStoreFilePath, content);
                }
                await fs.writeFileAsync(nameStoreFilePath, file.name);
            }
            if (!res.nextPageToken) {
                break;
            }
            pageToken = res.nextPageToken
            res = await makeRequest();
        }
    }
}

async function mainLoop() {
    let pageToken = (await fs.readFileAsync(config.drive.lastPageTokenStorePath, 'utf8')).trim();
    if (pageToken.length == 0) {
        console.log(`Warning: Corrupt initial start page token. Fetching again...`)
        pageToken = (await DriveApi.changesGetStartPageToken()).startPageToken;
    }
    console.log(`Using start page token: ${pageToken}`)

    let includeTeamDriveItems = true;
    let supportsTeamDrives = true;
    let includeRemoved = true;
    let res = await DriveApi.changesList({pageToken, includeTeamDriveItems, supportsTeamDrives, includeRemoved});

    const changes = [];
    while (true) {
        const nextPageToken = res.nextPageToken || res.newStartPageToken;
        if (pageToken == nextPageToken) {
            break;
        }

        console.log(`Next page token: ${nextPageToken}`)
        const filteredChanges = res.changes.filter(c => c.file && config.drive.teamDriveIds.includes(c.file.teamDriveId))
        changes.push(...filteredChanges)

        pageToken = nextPageToken
        res = await DriveApi.changesList({pageToken, includeTeamDriveItems, supportsTeamDrives, includeRemoved});
    }

    // change summary
    //console.log(`Changes: ${JSON.stringify(changes)}`);

    // run through changes backwards, tagging name updates...
    const nameByFileId = {}
    for (var i = changes.length - 1; i >= 0; i--) {
        if (changes[i].file && changes[i].file.name) {
            const id = changes[i].file.id
            if (id in nameByFileId) {
                changes[i].file.name = nameByFileId[id]
            }
            nameByFileId[id] = changes[i].file.name
        }
    }

    const summaryAdds = [];
    const summaryModifies = [];
    const summaryRemovals = [];
    for (var change of changes) {
        if (!change.file) continue;
        if (change.file.kind != 'drive#file') continue;
        if (change.file.mimeType != 'application/vnd.google-apps.document') continue;

        if (change.removed) {
            summaryRemovals.push(change);
            continue;
        }
        const content = await DriveApi.fetchDocsFileAsString(change.fileId);
        const headStoreFilePath = config.drive.headStorePath + '/' + change.file.id + '.txt'
        if (fs.existsSync(headStoreFilePath)) {
            const oldContent = await fs.readFileAsync(headStoreFilePath, 'utf8');
            const delta = JsDiff.diffWords(oldContent, content);
            //console.log(JSON.stringify(delta))

            const add = (a, b) => a + b;
            const wc = s => s.split(' ').filter(x => x.length).length;
            const wordsAdded = delta.filter(c => c.added).map(c => wc(c.value)).reduce(add, 0)
            const wordsRemoved = delta.filter(c => c.removed).map(c => wc(c.value)).reduce(add, 0)
            if (wordsAdded > 0 || wordsRemoved > 0) {
                summaryModifies.push([change, wordsAdded, wordsRemoved])
            }
        } else {
            summaryAdds.push(change)
        }
        await fs.writeFileAsync(headStoreFilePath, content)

        const nameStoreFilePath = config.drive.nameStorePath + '/' + change.file.id + '.txt'
        await fs.writeFileAsync(nameStoreFilePath, change.file.name);
    }

    const addedFiles = summaryAdds.sort((a, b) => a.file.name < b.file.name ? -1 : 1)
    const modifiedFiles = summaryModifies.sort((a, b) => - ((a[1] + a[2]) - (b[1] + b[2])))
    const removedFiles = summaryRemovals;

    let summaryLines = [];
    if (addedFiles.length) {
        const changeToString = (change) => change.file.name + " (https://docs.google.com/document/d/" + change.file.id + "/edit)";
        if (addedFiles.length == 1) {
            summaryLines.push('Added: ' + changeToString(addedFiles[0]))
        } else {
            summaryLines.push('Added: ')
            for (let file of addedFiles)
                summaryLines.push(' * ' + changeToString(file))
        }
    }
    if (modifiedFiles.length) {
        const deltaToString = (n, sign) => n > 0 ? `${sign}${n} ` : '';
        const changeToString = (arr) => deltaToString(arr[1], '+') + deltaToString(arr[2], '-') + 'in ' + arr[0].file.name + " (https://docs.google.com/document/d/" + arr[0].file.id + "/edit)";
        if (modifiedFiles.length == 1) {
            summaryLines.push('Changed: ' + changeToString(modifiedFiles[0]))
        } else {
            summaryLines.push('Changed: ')
            for (let arr of modifiedFiles) {
                summaryLines.push(' * ' + changeToString(arr))
            }
        }
    }

    // this doesn't work - we're not getting removed changes.
    if (removedFiles.length) {
        const changeFileName = async (c) => {
            const nameStoreFilePath = config.drive.nameStorePath + '/' + c.file.id + '.txt'
            if (!fs.existsSync(nameStoreFilePath)) return '(unknown)';
            return (await fs.readFileAsync(nameStoreFilePath), 'utf8').trim()
        }
        if (removedFiles.length == 1) {
            summaryLines.push('Removed: ' + await changeFileName(removedFiles[0]))
        } else {
            summaryLines.push('Removed: ')
            for (let c of removedFiles) {
                summaryLines.push(' * ' + await changeFileName(c))
            }
        }
    }

    if (summaryLines.length) {
        console.log(summaryLines.join('\r\n'))
        discordHook.send(summaryLines)
    }

    await fs.writeFileAsync(config.drive.lastPageTokenStorePath, pageToken)
}

DriveAuth.loaded.then(init).then(mainLoop);
