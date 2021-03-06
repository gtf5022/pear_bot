'use strict';

class PearTree {

    constructor(plantedBy, channelPlantedIn) {
        this.userID = plantedBy;
        this.ageInDays = 0;
        this.minutesThisDay = 0;
        this.minutesSinceWatered = 0;
        this.pears = 0;
        this.channelPlantedIn = channelPlantedIn;
    }

    parseItem(item) {
        this.userID = item.userID.S;
        this.ageInDays = parseInt(item.ageInDays.S);
        this.minutesThisDay = parseInt(item.minutesThisDay.S);
        this.minutesSinceWatered = parseInt(item.minutesSinceWatered.S);
        this.channelPlantedIn = item.channelPlantedIn.S;
        this.pears = parseInt(item.pears.S);
    }

    toItem() {
        return {
            userID: {'S': this.userID.toString()},
            ageInDays: {'S': this.ageInDays.toString()},
            minutesThisDay: {'S': this.minutesThisDay.toString()},
            minutesSinceWatered: {'S': this.minutesSinceWatered.toString()},
            pears: {'S': this.pears.toString()},
            channelPlantedIn: {'S': this.channelPlantedIn.toString()}
        };
    }

    ageByAMinute() {
        this.minutesSinceWatered += 1;
        this.minutesThisDay += 1;
        if (this.minutesThisDay >= 1440) {
            this.minutesThisDay = 0;
            this.ageInDays += 1;
        }
        if (Math.random() < PEAR_PROBABILITY * this.multiplier()) {
            this.pears += 1
        }
    }

    multiplier() {
        return 1 + Math.round(Math.log2(1 + (this.ageInDays * 0.25) + (this.pears * 0.75)));
    }

    harvest() {
        let pearsHarvested = this.pears;
        this.pears = 0;
        return pearsHarvested;
    }

    water() {
        this.minutesSinceWatered = 0;
    }
}

function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min));
}

const MS_PER_MINUTE = 60000;
const Search = require('azure-cognitiveservices-imagesearch');
const CognitiveServicesCredentials = require('ms-rest-azure').CognitiveServicesCredentials;
const Discord = require('discord.js');
const {createLogger, format, transports} = require('winston');
let auth = require('./auth.json');
let fs = require('fs');
let aws = require('aws-sdk');
aws.config.update({region: 'us-east-2'});
let db = new aws.DynamoDB({apiVersion: '2019-02-16'});
const TREE_TABLE_NAME = 'trees';
const SUBSCRIPTIONS_TABLE_NAME = 'subscriptions';
const PEAR_COUNTS_TABLE_NAME = 'pear_counts';
let subscribed = new Set();
let trees = {};
let pearCounts = [];

const I_EAT_PEARS_MP3 = "./pears.mp3";
const SHOUTOUT_MP3 = "./shoutout.mp3";

let reminderTimeout = -1;

let pearImageList = fs.readdirSync("./pear_pictures");

const MS_PER_DAY = 8.64e+7;
const PEAR_SEARCH_STRING = "pear";
const SEARCH_MODIFIERS = ['bartlett', 'anime', 'art', 'cute', 'animal crossing', 'bear'];

let bing_key = auth.bing_token;
let bing_credentials = new CognitiveServicesCredentials(bing_key);
let imageSearchApiClient = new Search.ImageSearchClient(bing_credentials);

const ALREADY_SUBSCRIBED_MESSAGE = 'This channel is already subscribed to Bartlett pear reminders! I appreciate your' +
    ' enthusiasm for the almighty pear.';
const DAILY_REMINDER_MESSAGE = 'This is your daily reminder that Bartlett pears are amazing.';
const SUBSCRIBE_SUCCESS_MESSAGE = 'You\'ve subscribed to Bartlett pear reminders!';
const TREE_HELPER_MESSAGE = "You can try \"!tree plant\", \"!tree water\", \"!tree harvest\", \"!tree status\" \"!tree count\" or \"!tree leader\"";
const NOT_SUBSCRIBED_MESSAGE = "This channel is not currently subscribed to Barlett Pear Reminders!";
const UNSUBSCRIBED_MESSAGE = "Unsubscribed. (This action has been recorded...)";

const PEAR_PROBABILITY = (1 / 720);

const logger = createLogger({
    format: format.combine(
        format.timestamp(),
        format.simple()
    ),
    transports: [
        new transports.Console({
            format: format.combine(
                format.timestamp(),
                format.colorize(),
                format.simple()
            )
        })
    ]
});

async function scanFromTable(tableName) {
    let result = null;
    await db.scan({TableName: tableName},
        (error, data) => {
            if (error) {
                logger.info(error);
            } else {
                result = data;
            }
        }).promise().catch(error => logger.info(error));
    return result;
}

async function putIntoTable(tableName, item) {
    let response = null;
    await db.putItem({TableName: tableName, Item: item}, (error, data) => {
        if (error) {
            logger.info(error);
        } else {
            response = data;
        }
    }).promise().catch(error => logger.info(error));
    return response;
}

async function deleteItemFromTable(tableName, key) {
    let result = null;
    await db.deleteItem({TableName: tableName, Key: key}, (error, data) => {
        if (error) {
            logger.info(error);
        } else {
            result = data;
        }
    }).promise().catch(error => logger.info(error));
    return result;
}

let client = new Discord.Client();

let treeAgeIntervalID = -1;
let reminderTimeoutID = -1;

scanFromTable(SUBSCRIPTIONS_TABLE_NAME)
    .then(results => {
        results.Items.forEach(result => subscribed.add(result.channelID.S));
        scanFromTable(TREE_TABLE_NAME).then(results => {
            results.Items.forEach(result => {
                let tree = new PearTree();
                tree.parseItem(result);
                trees[tree.userID] = tree;
            });
            logger.info("Initiated trees size:" + Object.keys(trees).length);
            scanFromTable(PEAR_COUNTS_TABLE_NAME).then(results => {
                results.Items.forEach(result => pearCounts[result.userID.S] = parseInt(result.pearsHarvested.N));
                client.login(auth.token);
            })
        });
    });

client.on('ready', () => {
    logger.info('Connected,');
    logger.info('Logged in as: ');
    logger.info(client.user.username + ' - (' + client.user.id + ')');
    logger.info('Initialized subscribed list of size: ' + subscribed.size);

    reminderTimeout = randomInt(0, MS_PER_DAY);
    logger.info("Initial reminderTimeout: " + reminderTimeout);

    if (reminderTimeoutID !== -1) {
        clearTimeout(reminderTimeoutID);
    }
    if (treeAgeIntervalID !== -1) {
        clearTimeout(treeAgeIntervalID);
    }
    reminderTimeoutID = setTimeout(sendOutReminders, reminderTimeout);
    treeAgeIntervalID = setTimeout(ageTreesByMinute, MS_PER_MINUTE);
});
client.on('disconnect', function (errMsg, code) {
    logger.info("Disconnected, trying to reconnect.");
    clearTimeout(treeAgeIntervalID);
    clearTimeout(reminderTimeoutID);
    client.connect();
});
client.on('error', error => logger.info(error.toString()));

function playFileInVoiceChannel(filename, voiceChannel) {
    if (voiceChannel === undefined || voiceChannel === null) {
        return;
    }
    voiceChannel.join().then(connection => {
        connection.play(filename).on('end', () => {
            setTimeout(() => {
                voiceChannel.leave()
            }, 2000);
        });
    }).catch(console.error);
}

client.on('message', message => {

    let userID = message.author.id;
    let channelID = message.channel.id;
    let content = message.content;
    if (content.substring(0, 1) === '!') {
        let args = content.substring(1).split(' ');
        let cmd = args[0];
        args = args.splice(1);
        switch (cmd) {
            case 'unsubscribe':
                unsubscribeFromReminders(channelID);
                break;
            case 'subscribe':
                subscribeToReminders(channelID);
                break;
            case 'pearme':
                sendPearToChannel(channelID);
                break;
            case 'tree':
                performTreeOps(channelID, userID, args[0]);
                break;
            case 'clean':
                deleteMessagesFromChannel(channelID);
                break;
            case 'eatpears':
                playFileInVoiceChannel(I_EAT_PEARS_MP3, message.member.voice.channel);
                break;
            case 'shoutout':
                playFileInVoiceChannel(SHOUTOUT_MP3, message.member.voice.channel);
                break;
        }
    }
});

const TREE_DEATH_TIMEOUT = 1440 + 60;

function deleteMessagesFromChannel(channelID) {
    //TODO: Update this function to utilize discordjs 12
}

function ageTreesByMinute() {
    for (let userID in trees) {
        let tree = trees[userID];
        tree.ageByAMinute();
        putIntoTable(TREE_TABLE_NAME, tree.toItem());
        if (tree.minutesSinceWatered === TREE_DEATH_TIMEOUT - (3 * 60)) {
            let channel = tree.channelPlantedIn;
            sendMessageToChannel(channel, "<@" + userID + ">'s pear tree is withering. It needs water soon!");
        }
        if (tree.minutesSinceWatered >= TREE_DEATH_TIMEOUT) {
            let channel = tree.channelPlantedIn;
            delete trees[userID];
            deleteItemFromTable(TREE_TABLE_NAME, {userID: {'S': userID}});
            sendMessageToChannel(channel, "The tree planted by " + getUsername(userID) + " has died!");
        }
    }
    treeAgeIntervalID = setTimeout(ageTreesByMinute, MS_PER_MINUTE);
}

function sendMessageToChannel(channelID, message) {
    let channel = client.channels.get(channelID);
    if (channel !== undefined) {
        channel.send(message);
    }
}

function getPearSearchString() {
    return SEARCH_MODIFIERS[randomInt(0, SEARCH_MODIFIERS.length - 1)] + " " + PEAR_SEARCH_STRING;
}

function sendOutReminders() {
    let imageResults = imageSearchApiClient.imagesOperations.search(getPearSearchString());
    let urlString = "";
    if (imageResults !== null) {
        imageResults.then(results => {
            logger.info("Image search success");
            urlString = results.value[randomInt(0, results.value.length - 1)].contentUrl;
            logger.info("Url string: " + urlString);
            subscribed.forEach(channelID => {
                sendMessageToChannel(channelID, DAILY_REMINDER_MESSAGE + "\n" + urlString);
            });
        }).catch(err => {
            subscribed.forEach(channelID => {
                sendMessageToChannel(channelID, DAILY_REMINDER_MESSAGE);
            });
            logger.info("Image search fail");
            logger.info(err.toString());
        });
    }
    reminderTimeout = randomInt(0, MS_PER_DAY * 2);
    logger.info('Reminder sent, next reminder in ' + reminderTimeout + ' ms');
    reminderTimeoutID = setTimeout(sendOutReminders, reminderTimeout);
}

function sendPearToChannel(channelID) {
    let image = "./pear_pictures/" + pearImageList[randomInt(0, pearImageList.length - 1)];
    logger.info("Pear requested: " + image);
    client.channels.get(channelID).send({files: [image]});
}

function plantTree(channelID, userID) {
    if (trees[userID] !== undefined) {
        sendMessageToChannel(channelID, "You already have a tree planted!");
    } else {
        trees[userID] = new PearTree(userID, channelID);
        putIntoTable(TREE_TABLE_NAME, trees[userID].toItem());
        sendMessageToChannel(channelID, getUsername(userID) + " planted a pear tree! Don't forget to"
            + " water it once a day.");
    }
    if (pearCounts[userID] === undefined) {
        pearCounts[userID] = 0;
    }
}

function waterTree(channelID, userID) {
    let tree = trees[userID];
    if (tree !== undefined) {
        sendMessageToChannel(channelID, "You watered your tree!");
        tree.water();
        tree.channelPlantedIn = channelID;
        putIntoTable(TREE_TABLE_NAME, tree.toItem());
    } else {
        sendMessageToChannel(channelID, "You don't have a tree to water! Try \"!tree plant\"");
    }
}

function addPearsToCount(userID, pearsHarvested) {
    if (pearCounts[userID] === undefined) {
        pearCounts[userID] = 0;
    }
    pearCounts[userID] += pearsHarvested;
    putIntoTable(PEAR_COUNTS_TABLE_NAME, getPearCountItem(userID));
}

function getUsername(userID) {
    let user = client.users.get(userID);
    if (user !== undefined) {
        return user.username + "#" + user.discriminator;
    }
}

function harvestTree(channelID, userID) {
    let tree = trees[userID];
    if (tree !== undefined) {
        let pearsHarvested = tree.harvest();
        tree.channelPlantedIn = channelID;
        addPearsToCount(userID, pearsHarvested);
        putIntoTable(TREE_TABLE_NAME, tree.toItem());
        sendMessageToChannel(channelID, getUsername(userID) + " harvested " + pearsHarvested + " pears!\n"
            + getUsername(userID) + ": " + (pearCounts[userID] - pearsHarvested) + " + " + pearsHarvested + " = "
            + pearCounts[userID])
    } else {
        sendMessageToChannel(channelID, "You don't have a tree to harvest! Try \"!tree plant\"");
    }
}

function getWateredTimeElapsed(minutesSinceWatered) {
    if (minutesSinceWatered < 60) {
        return "less than an hour ago";
    } else {
        return Math.floor(minutesSinceWatered / 60) + " hours ago";
    }
}

function sendTreeStatus(channelID, userID) {
    let tree = trees[userID];
    if (tree !== undefined) {
        tree.channelPlantedIn = channelID;
        sendMessageToChannel(channelID, "Age: " + tree.ageInDays + " days \nWatered: "
            + getWateredTimeElapsed(tree.minutesSinceWatered) + "\nPears: " + tree.pears + " \n" +
            "Growth factor: " + tree.multiplier() + "X");
    } else {
        sendMessageToChannel(channelID, "You do not have a tree! Try \"!tree plant\"");
    }
}

function getPearCountItem(userID) {
    return {userID: {'S': userID.toString()}, pearsHarvested: {'N': pearCounts[userID].toString()}}
}

function sendPearCount(channelID, userID) {
    if (pearCounts[userID] === undefined) {
        pearCounts[userID] = 0;
        putIntoTable(PEAR_COUNTS_TABLE_NAME, getPearCountItem(userID));
    }
    sendMessageToChannel(channelID, getUsername(userID) + ": " + pearCounts[userID]);
}

function sendPearLeaderboard(channelID) {
    let message = "";
    let leaderboard = [];
    for (let userID in pearCounts) {
        leaderboard.push({uid: userID, val: pearCounts[userID]});
    }
    leaderboard.sort(function (a, b) {
        return b.val - a.val;
    });
    for (let i = 0; i < leaderboard.length; i++) {
        let username = getUsername(leaderboard[i].uid);
        let pearCount = pearCounts[leaderboard[i].uid];
        message += (i + 1) + ") " + username + " : " + pearCount + "\n";
    }
    sendMessageToChannel(channelID, message);
}

function performTreeOps(channelID, userID, subfunction) {
    switch (subfunction) {
        case "plant":
            plantTree(channelID, userID);
            break;
        case "water":
            waterTree(channelID, userID);
            break;
        case "harvest":
            harvestTree(channelID, userID);
            break;
        case "status":
            sendTreeStatus(channelID, userID);
            break;
        case "count":
            sendPearCount(channelID, userID);
            break;
        case "leader":
            sendPearLeaderboard(channelID);
            break;
        default:
            sendMessageToChannel(channelID, TREE_HELPER_MESSAGE);
            break;
    }
}

function unsubscribeFromReminders(channelID) {
    if (!subscribed.has(channelID)) {
        sendMessageToChannel(channelID, NOT_SUBSCRIBED_MESSAGE);
        return;
    }
    subscribed.delete(channelID);
    sendMessageToChannel(channelID, UNSUBSCRIBED_MESSAGE);
    logger.info("Unsubscribed size: " + subscribed.size);
    deleteItemFromTable(SUBSCRIPTIONS_TABLE_NAME, {channelID: {'S': channelID.toString()}});
}

function subscribeToReminders(channelID) {
    if (subscribed.has(channelID)) {
        sendMessageToChannel(channelID, ALREADY_SUBSCRIBED_MESSAGE);
        return;
    }
    let item = {channelID: {'S': channelID}};
    putIntoTable(SUBSCRIPTIONS_TABLE_NAME, item).then(result => logger.info(result.toString()));
    subscribed.add(channelID);
    logger.info('Subscribed size: ' + subscribed.size);
    sendMessageToChannel(channelID, SUBSCRIBE_SUCCESS_MESSAGE);
}
