# LiteLoaderQQNT-Message-Storage

A plugin of [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT).  
Store QQNT chat messages in SQLite, using a local database instead of the built-in database and cloud synchronization feature to achieve **efficient search** and **data migration**.

The code logic of message interception is referenced from [anti-recall](https://github.com/xh321/LiteLoaderQQNT-Anti-Recall), so it would store the recalled messages sometimes.

Download here: [release](https://github.com/u1805/LiteLoaderQQNT-Message-Storage/releases), and it is tested on `QQNT v9.9.15-28498 (64bit)`

## Database Schema
```sql
CREATE TABLE IF NOT EXISTS info (
    id TEXT PRIMARY KEY,     -- Message ID
    senderUin TEXT,          -- Sender's QQ ID
    sendNickName TEXT,       -- Sender's Nickname
    sendMemberName TEXT,     -- Sender's Group Member Name
    peerUin TEXT,            -- Group ID / Receiver's QQ
    peerName TEXT,           -- Group Name / Receiver's Nickname
    msgTime INTEGER,         -- Message Timestamp in seconds
    chatType INTEGER，       -- 1: Private, 2: Group
    msgRandom INTEGER        -- An anchor for reply message
);

-- A Message contains multiple elements like text, image, emoji, reply, forward...
CREATE TABLE IF NOT EXISTS content (
    id TEXT ,                -- Message ID
    elementId TEXT,          -- Element ID
    elementType INTEGER,     -- Element Type: 1: Text, 2&11: Image, 6: Emoji, 7: Reply, 16: Forward
    content BLOB,            -- Use BLOB to store any type of content, especially for images
    PRIMARY KEY (id, elementId)
);
```

## Basic SQL

```sql
SELECT 
    info.id, elementId, 
    senderUin, sendMemberName, sendNickName, 
    peerUin, peerName,
    elementType, content
from info JOIN content 
WHERE info.id = content.id 
-- AND content LIKE '%search_keyword%'
AND content.elementType IN (1, 2, 6, 7, 11, 16)
ORDER BY msgTime DESC;
```

> Images are stored as BLOB, so you need to convert them to image format before displaying them, like this:
> ```bash
> sqlite3 ".\qq-storage.sqlite" "select writefile('image.png', content) from content where elementId='7450882919979556275'"
>```

## Query Interface

To make data queries more convenient, we provide a query page ⇒ [here](https://u1805.github.io/LiteLoaderQQNT-Message-Storage/).