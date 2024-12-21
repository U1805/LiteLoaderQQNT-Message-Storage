const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { app, ipcMain, dialog } = require("electron");

var configFilePath = "";
var pluginDataDir = path.join(LiteLoader.path.data, "message_storage");
var dbFile = path.join(pluginDataDir, "qq-storage.sqlite");
var db = null;

var sampleConfig = {
    maxMsgSaveLimit: 10000,
    deleteMsgCountPerTime: 500,
};

var nowConfig = {};

function initConfig() {
    fs.writeFileSync(configFilePath, JSON.stringify(sampleConfig, null, 2), "utf-8");
}

function loadConfig() {
    if (!fs.existsSync(configFilePath)) {
        initConfig();
        return sampleConfig;
    } else {
        return JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
    }
}

async function openOrCreateDatabase(retryCount = 0) {
    const MAX_RETRIES = 3;
    try {
        const db = await new Promise((resolve, reject) => {
            const database = new sqlite3.Database(dbFile, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(database);
                }
            });
        });

        if (!db) {
            output("Database connection failed");
        }

        // 初始化表结构
        db.serialize(() => {
            db.run(`
            CREATE TABLE IF NOT EXISTS info (
                id TEXT PRIMARY KEY,      -- 消息id
                senderUin TEXT,          -- 发送者QQ
                sendNickName TEXT,       -- 发送者昵称
                sendMemberName TEXT,     -- 发送者群名片
                peerUin TEXT,            -- 群号/接受者QQ
                peerName TEXT,           -- 群名/接受者昵称
                msgTime INTEGER,         -- 发送时间戳s
                chatType INTEGER         -- 1 好友 2 群聊
            );
            `);
            db.run(`
            CREATE TABLE IF NOT EXISTS content (
                id TEXT ,                -- 消息id
                elementId TEXT,          -- 元素id
                elementType INTEGER,     -- 元素类型 1: 文字 2: 图片 6: 表情 7: 回复 16: 转发
                content BLOB,            -- Use BLOB to store any type of content
                PRIMARY KEY (id, elementId)
            );
          `);
        });

        output("Successfully opened database:", dbFile);
        return db;
    } catch (err) {
        // 检查是否达到最大重试次数
        if (retryCount >= MAX_RETRIES) {
            output("达到最大重试次数，初始化数据库失败:", err);
            throw err;
        }

        output(`数据库操作失败 (尝试 ${retryCount + 1}/${MAX_RETRIES}):`, err);

        try {
            // 生成备份文件名
            const timestamp = Date.now();
            const backupFile = path.join(pluginDataDir, `qq-storage_backup_${timestamp}.sqlite`);

            // 如果原数据库文件存在，进行备份
            if (fs.existsSync(dbFile)) {
                try {
                    fs.renameSync(dbFile, backupFile);
                    output(`已将现有数据库备份到: ${backupFile}`);
                } catch (backupErr) {
                    output("备份数据库失败:", backupErr);
                    throw backupErr;
                }
            }

            // 删除可能存在的损坏的数据库文件
            if (fs.existsSync(dbFile)) {
                fs.unlinkSync(dbFile);
            }

            // 递归重试，增加重试计数
            output("正在重试创建新的数据库...");
            return await openOrCreateDatabase(retryCount + 1);
        } catch (handlingErr) {
            output("处理错误过程中发生异常:", handlingErr);
            throw handlingErr;
        }
    }
}

onLoad();

async function onLoad() {
    if (!fs.existsSync(pluginDataDir)) {
        fs.mkdirSync(pluginDataDir, { recursive: true });
    }
    configFilePath = path.join(pluginDataDir, "config.json");
    nowConfig = loadConfig();
    fs.writeFileSync(configFilePath, JSON.stringify(nowConfig, null, 2), "utf-8");
    db = await openOrCreateDatabase();

    app.on("quit", async () => {
        output("Closing db...");
        await db.close();
    });
}

var msgFlow = [];

async function insertDb(msg) {
    let elementList = [];
    for (const element of msg["elements"]) {
        let content = null;
        if (element["elementType"] === 1) content = element["textElement"]["content"];
        else if (element["elementType"] === 2) content = await fs.promises.readFile(element["picElement"]["sourcePath"]);
        else if (element["elementType"] === 6) content = element["faceElement"]["faceIndex"];
        else if (element["elementType"] === 7) content = element["replyElement"]["sourceMsgIdInRecords"];
        else if (element["elementType"] === 16) content = element["multiForwardMsgElement"]["xmlContent"];
        else content = JSON.stringify(msg, null, 2);

        elementList.push([msg["msgId"], element["elementId"], element["elementType"], content]);
    }

    if (db != null) {
        db.serialize(() => {
            // 插入消息信息（发送人 发送时间...
            db.run(
                `INSERT INTO info (
                    id, 
                    senderUin,
                    sendNickName,
                    sendMemberName,
                    peerUin,
                    peerName,
                    msgTime,
                    chatType
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    msg["msgId"],
                    msg["senderUin"],
                    msg["sendNickName"],
                    msg["sendMemberName"],
                    msg["peerUin"],
                    msg["peerName"],
                    parseInt(msg["msgTime"]),
                    msg["chatType"],
                ],
                (insertErr) => {
                    if (insertErr) {
                        output("Error inserting data:", insertErr);
                    }
                }
            );

            // 插入消息内容
            for (const element of elementList) {
                db.run(
                    `INSERT INTO content (
                        id, 
                        elementId,
                        elementType,
                        content
                    ) VALUES (?, ?, ?, ?)`,
                    element,
                    (insertErr) => {
                        if (insertErr) {
                            output("Error inserting data:", insertErr);
                        }
                    }
                );
            }
        });
    }
}

async function getMsgById(id) {
    if (db != null) {
        try {
            return await db.get(id);
        } catch (e) {
            if (e.status != 404) {
                output(e);
            }
            return null;
        }
    } else {
        output("Warning: Db is null, no previous msg available.");
    }
    return null;
}

var mainWindowObjs = [];
function onBrowserWindowCreated(window) {
    window.webContents.on("did-stop-loading", () => {
        //只针对主界面和独立聊天界面生效
        if (window.webContents.getURL().indexOf("#/main/message") != -1 || window.webContents.getURL().indexOf("#/chat") != -1) {
            mainWindowObjs.push(window);

            const original_send = (window.webContents.__qqntim_original_object && window.webContents.__qqntim_original_object.send) || window.webContents.send;

            const patched_send = async function (channel, ...args) {
                try {
                    if (args.length >= 2) {
                        //MessageList IPC 中能看到消息全量更新内容，其中包含撤回的提示，但并不包含被撤回的消息（被撤回的已经被替换掉了），需要替换撤回提示为之前保存的消息内容
                        if (
                            args.some((item) => item && item.hasOwnProperty("msgList") && item.msgList != null && item.msgList instanceof Array && item.msgList.length > 0)
                        ) {
                            for (const msg of args[1].msgList) {
                                insertDb(msg);
                            }
                        }
                        //增量更新 IPC
                        if (args.some((item) => item instanceof Array && item.length > 0 && item[0] && item[0].cmdName != null)) {
                            var args1 = args[1][0];
                            if (args1 == null) return;

                            if (args1.cmdName.indexOf("onProfileDetailInfoChanged") != -1) {
                                myUid = args1.payload.info.uid;
                            }
                            //接到消息
                            if (
                                (args1.cmdName != null &&
                                    args1.payload != null &&
                                    (args1.cmdName.indexOf("onRecvMsg") != -1 || args1.cmdName.indexOf("onRecvActiveMsg") != -1) &&
                                    args1.payload.msgList instanceof Array) ||
                                (args1.cmdName.indexOf("onAddSendMsg") != -1 && args1.payload.msgRecord != null) ||
                                (args1.cmdName.indexOf("onMsgInfoListUpdate") != -1 && args1.payload.msgList instanceof Array)
                            ) {
                                var msgList = args1.payload.msgList instanceof Array ? args1.payload.msgList : [args1.payload.msgRecord];

                                for (msg of msgList) {
                                    var msgId = msg.msgId;

                                    var olderMsgIdx = msgFlow.findIndex((i) => i.id == msgId);
                                    if (olderMsgIdx == -1) {
                                        msgFlow.push({});
                                        olderMsgIdx = msgFlow.length - 1;
                                    }
                                    msgFlow[olderMsgIdx] = {
                                        id: msgId,
                                        sender: msg.peerUid,
                                        msg: msg,
                                    };
                                    insertDb(msgFlow[olderMsgIdx]["msg"]);

                                    if (nowConfig.maxMsgSaveLimit == null) {
                                        nowConfig.maxMsgSaveLimit = 10000;
                                    }
                                    if (nowConfig.deleteMsgCountPerTime == null) {
                                        nowConfig.deleteMsgCountPerTime = 500;
                                    }

                                    if (msgFlow.length > nowConfig.maxMsgSaveLimit) {
                                        msgFlow.splice(0, nowConfig.deleteMsgCountPerTime);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    output("NTQQ Message-Storage Error: ", e);
                }

                return original_send.call(window.webContents, channel, ...args);
            };
            if (window.webContents.__qqntim_original_object) window.webContents.__qqntim_original_object.send = patched_send;
            else window.webContents.send = patched_send;

            output("NTQQ Message-Storage loaded for window: " + window.webContents.getURL());
        }
    });
}

function output(...args) {
    console.log("\x1b[32m%s\x1b[0m", "[Message-Storage]:", ...args);
}

module.exports = {
    onBrowserWindowCreated,
};
