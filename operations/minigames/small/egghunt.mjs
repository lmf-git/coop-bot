import _ from 'lodash';

import { RAW_EMOJIS, EMOJIS, CHANNELS as CHANNELS_CONFIG } from 'coop-shared/config.mjs';
import Items from 'coop-shared/services/items.mjs';
import Useable from 'coop-shared/services/useable.mjs';

import COOP, { STATE, CHICKEN, CHANNELS, ITEMS, MESSAGES, USERS, ROLES, REACTIONS } from '../../../coop.mjs';

import EconomyNotifications from '../../activity/information/economyNotifications.mjs';
import DropTable from '../medium/economy/items/droptable.mjs';
import ItemsHelper from '../medium/economy/items/itemsHelper.mjs';
import UsableItemHelper from '../medium/economy/items/usableItemHelper.mjs';
import SkillsHelper from '../medium/skills/skillsHelper.mjs';

import { isRegisteredUserGuard } from '../medium/economy/itemCmdGuards.mjs';
import ReactionHelper from '../../activity/messages/reactionHelper.mjs';
import TemporaryMessages from '../../activity/maintenance/temporaryMessages.mjs';





export const EGG_DATA = {
    TOXIC_EGG: {
        points: -10,
        emoji: EMOJIS.TOXIC_EGG
    },
    AVERAGE_EGG: {
        points: 3,
        emoji: EMOJIS.AVERAGE_EGG
    },
    RARE_EGG: {
        points: 10,
        emoji: EMOJIS.RARE_EGG
    },
    LEGENDARY_EGG: {
        points: 100,
        emoji: EMOJIS.LEGENDARY_EGG
    },
};


export default class EggHuntMinigame {

    static isEgghuntDrop(messageStr) {
        const eggEmojiNames = _.map(_.values(EGG_DATA), "emoji");
        const emojiIdentifier = MESSAGES.purifyEmojiIDStr(messageStr);
        return eggEmojiNames.includes(emojiIdentifier);
    }

    static async onReaction(reaction, user) {
        try {
            // Prevent Cooper from collecting his own eggs.
            if (USERS.isCooper(user.id)) return false;

            const isCooperMessage = USERS.isCooperMsg(reaction.message);
            const isEgghuntDrop = this.isEgghuntDrop(reaction.message.content);
            const rarity = this.calculateRarityFromMessage(reaction.message);
            const isEggCollectible = isCooperMessage && isEgghuntDrop && rarity;

            const isBombEmoji = reaction.emoji.name === RAW_EMOJIS.BOMB;
            const isBasketEmoji = reaction.emoji.name === RAW_EMOJIS.BASKET;
            const isHammerEmoji = reaction.emoji.name === RAW_EMOJIS.HAMMER;

            const isPanEmoji = reaction.emoji.name === 'frying_pan';

            // Check user is in the database:
            if (!await isRegisteredUserGuard(reaction.message, user)) 
                return false;

            if (isEggCollectible && isPanEmoji) this.fry(reaction, user);
            if (isEggCollectible && isBombEmoji) this.explode(reaction, user);
            if (isEggCollectible && isHammerEmoji) this.break(reaction.message, user, rarity, true);

            // Prevent collection of dropped egg effects (cyclical).
            const wasDropped = UsableItemHelper.isDroppedItemMsg(reaction.message);

            // Disallow egghunt effects on dropped eggs.
            const egghuntDroppedEgg = isEggCollectible && isBasketEmoji && !wasDropped;

            // If collectible, collect emoji and wasn't dropped, allow collection.
            if (egghuntDroppedEgg) this.collect(reaction, user);

        } catch(e) {
            console.error(e);
        }
    }

    static calculateRarityFromMessage(msg) {
        let eggRarity = null;

        if (msg.content.indexOf('average_egg') > -1) eggRarity = 'AVERAGE_EGG';
        if (msg.content.indexOf('rare_egg') > -1) eggRarity = 'RARE_EGG';
        if (msg.content.indexOf('legendary_egg') > -1) eggRarity = 'LEGENDARY_EGG';
        if (msg.content.indexOf('toxic_egg') > -1) eggRarity = 'TOXIC_EGG';

        return eggRarity;
    }

    static async processBombDrop(msgRef, rarity, user) {
        // Ignore toxic eggs for now.
        if (rarity === 'TOXIC_EGG') return false;

        const tierLevel = rarity.replace('_EGG', '');
        const reward = DropTable.getRandomTieredWithQty(tierLevel);

        const actionTypeText = MESSAGES.randomChars(7);
        const subjectText = `the ${tierLevel.toLowerCase()} egg`;
        const actionText = `${user.username} ${actionTypeText}'d items from bombing ${subjectText}...`;
        const emojiText = MESSAGES.emojiText(EMOJIS[rarity]);
        const emojiItemText = MESSAGES.emojiText(EMOJIS[reward.item]);
        const eventText = `${actionText} ${emojiText}\n${emojiItemText} ${reward.item}x${reward.qty}`;
        
        CHANNELS.silentPropagate(msgRef, eventText, 'ACTIONS', 10000);
        
        await Items.add(user.id, reward.item, reward.qty, `EGGHUNT_BOMB_REWARD - ${actionTypeText}'d ${rarity} (bomb)`);
    }

    // TODO: Add a small chance of bomb exploding on you.
    static async explode(reaction, user) {

        // Check if user has a bomb to use
        try {
            // TODO: Allow all other explosives to do this too.
            const bombQuantity = await Items.getUserItemQty(user.id, 'BOMB');

            const rarity = this.calculateRarityFromMessage(reaction.message);
            const reward = EGG_DATA[rarity].points;
            const emoji = EGG_DATA[rarity].emoji;

            // Remove reaction by user without a bomb and prevent usage.
            if (bombQuantity <= 0) return await reaction.users.remove(user.id);

            // Remove bomb from user.
            await Items.subtract(user.id, 'BOMB', 1, `Bombed an ${rarity}`);

            // User has enough eggs, blow egg up.
            const blownupEggMsg = await reaction.message.edit('💥... egg destroyed');
            // MESSAGES.delayDelete(blownupEggMsg, 3333);

            // Share points with nearest 5 message authors.
            const channelMessages = reaction.message.channel.messages;
            const surroundingMsgs = await channelMessages.fetch({ around: reaction.message.id, limit: 40 });
            const aroundUsers = surroundingMsgs.reduce((acc, msg) => {
                const notCooper = !USERS.isCooperMsg(msg);
                const notIncluded = typeof acc[msg.author.id] === 'undefined';
                if (notIncluded && notCooper) acc[msg.author.id] = msg.author;
                return acc;
            }, {});

            // Store points and egg collection data in database.
            const awardedUserIDs = Object.keys(aroundUsers);
            Promise.all(awardedUserIDs.map(userID => Items.add(userID, 'COOP_POINT', reward, `EGGHUNT_BOMB_SPLASH_REWARD - Bombed ${rarity} splash effect`)));

            // Add/update random item to user if it was a legendary egg
            this.processBombDrop(reaction.message, rarity, user);

            // Create feedback text from list of users.
            const usersRewardedText = awardedUserIDs.map(userID => aroundUsers[userID].username).join(', ');
            const emojiText = MESSAGES.emojiText(emoji);
            const feedbackMsg = `${usersRewardedText} gained ${reward} points by being splashed by exploding egg ${emojiText}`.trim();
            
            // Add server notification in feed.
            CHANNELS.propagate(reaction.message, feedbackMsg, 'ACTIONS')

        } catch(e) {
            console.error(e);
        }
    }

    static async fry(reaction, user) {
        try {
            // Attempt to use the laxative item
            const didUsePan = await Useable.use(user.id, 'FRYING_PAN', 1);
    
            // Respond to usage result.
            if (didUsePan) {
                const rarity = this.calculateRarityFromMessage(reaction.message);
                const { points, emoji } = EGG_DATA[rarity];
    
                // Invert rewards, good egg cooked is wasting, bad egg cooked is rewarding.
                const actionReward = -points;   
    
                // Process the points change.
                const updatedPoints = await Items.add(user.id, 'COOP_POINT', actionReward, `EGGHUNT_REWARD_FRIED - Fried toxic egg`);
    
                // TODO: Maybe include in output message??
                await SkillsHelper.addXP(user.id, 'cooking', 3);

                // Generate feedback test based on the changes.
                const feedbackText = `${user.username} fried <${emoji}>! ` +
                    `Resulting in ${actionReward} point(s) change (now ${ITEMS.displayQty(updatedPoints)}) and 5 cooking XP!`;
                
                // Modify fried egg.
                await reaction.message.edit(feedbackText); 

                // Remove the emojis
                REACTIONS.removeAll(reaction.message);

            } else {
                const unableMsg = await reaction.message.channel.send('Unable to use FRYING_PAN, you own none. :/');
                reaction.users.remove(user.id);
                // MESSAGES.delayReact(unableMsg, EMOJIS.FRYING_PAN, 1333);
                MESSAGES.delayDelete(unableMsg, 900);
            }
        } catch(e) {
            console.log('Frying egg failed...');
            console.error(e);
        }
    };

    static handleChristmasRelease(reaction, user) {
        // Limit Christmas egg releases.
        const currentDate = new Date();
        if (currentDate.getMonth() !== 11) return null;
        if (STATE.CHANCE.bool({ likelihood: 85 })) return null;

        // Inform the user of the CHRISTMAS_EGG reward.
        const christmasEggEmoji = MESSAGES.emojiCodeText('CHRISTMAS_EGG');
        const christmasReleaseText = `You randomly found a CHRISTMAS_EGG ${christmasEggEmoji}!`;
        MESSAGES.selfDestruct(reaction.message, christmasReleaseText, 0, 666);

        // Add the item to the user's ownership.
        Items.add(user.id, 'CHRISTMAS_EGG', 1, `EGGHUNT_REWARD_CHRISTMAS - Christmas egg release.`);
    };

    static async collect(reaction, user) {
        try {
            // Ignore later reactions than the first one.
            if (reaction.count > 2) return null;

            const rarity = this.calculateRarityFromMessage(reaction.message);
            const reward = EGG_DATA[rarity].points;
            const rewardPolarity = reward > 0 ? '+' : '';
            const emoji = EGG_DATA[rarity].emoji;

            // Small chance of being stolen by a fox.
            if (STATE.CHANCE.bool({ likelihood: 5 }))
                return await this.steal(reaction.message, user, rarity);

            // Check the channel type or location of the action.
            let location = null;
            if (reaction.message.channel.type === 'DM') location = 'direct message'
            else location = `"${reaction.message.channel.name}" channel`;

            // Setup the text for feedback messages.
            let acknowledgementMsgText =`${user.username} ${rewardPolarity}${reward} points!`.trim();
            let activityFeedMsgText = `${user.username} collected an egg in ${location}! <${emoji}>`.trim();

            // TODO: If Cooper is evil you break more pickaxes, axes, frying pans and eggs.
            if (STATE.CHANCE.bool({ likelihood: 83 })) {
                // Store points and egg collection data in database.
                const updatedPoints = await Items.add(user.id, 'COOP_POINT', reward, `EGGHUNT_COLLECTED_${rarity.toUpperCase()}_REWARD_POINTS Collected ${rarity}`);
                const updated = ItemsHelper.displayQty(updatedPoints);

                acknowledgementMsgText += ` (${updated})`;
                
                // Add/update egg item to user
                await Items.add(user.id, rarity, 1, `EGGHUNT_COLLECTED_${rarity.toUpperCase()}`);

                // Update economy statistics.
                EconomyNotifications.add('EGG_HUNT', {
                    // playerID: user.id,
                    // username: user.username,
                    type: 'COLLECT',
                    eggType: rarity,
                    pointGain: reward
                });

                // Animate the egg collection.
                const basketEmojiText = MESSAGES.emojiText(RAW_EMOJIS.BASKET);
                MESSAGES.delayEdit(
                    reaction.message, 
                    `${MESSAGES.emojiText(emoji)}${basketEmojiText}💨 ${acknowledgementMsgText}`, 
                    0
                );

                // Remove the emojis
                REACTIONS.removeAll(reaction.message);

                // Conditionally handle Christmas release of eggs.
                this.handleChristmasRelease(reaction, user);
            } else {
                this.break(reaction.message, user, rarity);
                activityFeedMsgText = `${user.username} broke an egg in ${location}! :( <${emoji}>`.trim();
            }

            // Sometimes tell the-barn that an egg was collected and where.
            if (STATE.CHANCE.bool({ likelihood: .5 }) && reaction.message.channel.id !== CHANNELS_CONFIG.TALK.id)
                CHANNELS._send('TALK', activityFeedMsgText);

        } catch(e) {
            console.error(e);
        }
    };

    static async steal(msg, user, rarity) {
        const emoji = EGG_DATA[rarity].emoji;
        await msg.edit(`${user.username}'s ${MESSAGES.emojiText(emoji)} was stolen by a fox 🦊`);

        // Convert the rarity variable into chicken config key example: "stolen_average_egg"
        const configKey = `stolen_${rarity.toLowerCase()}`;

        // Fetch the current amount of stolen eggs of this rarity and increment
        const currentAmount = await CHICKEN.getConfig(configKey);
        const newAmount = (parseInt(currentAmount) || 0) + 1;

        // Update the value in chicken config
        CHICKEN.setConfig(configKey, newAmount);
        return ReactionHelper.removeAll(msg);
    };

    static async break(msg, user, rarity, intentional = false) {
        try {
            // Small chance of being stolen instead of broken
            if (STATE.CHANCE.bool({ likelihood: 5 }) && intentional)
                return await this.steal(msg, user, rarity);

            const emoji = MESSAGES.emojiText(EGG_DATA[rarity].emoji);
            const actionText = `${emoji}🔨 ${user.username}`;
            
            // Record the break event
            await this.recordBreak(rarity);

            
            let acknowledgementMsgText = `${actionText} ${intentional ? 'intentionally' : 'clumsily'} broke the egg...`.trim();
            
            // Handle intentional breaks
            if (intentional) {
                const reward = -Math.ceil(EGG_DATA[rarity].points / 2);
                const rewardPolarity = reward > 0 ? '' : '-';
                acknowledgementMsgText += ` ${rewardPolarity}${reward} points!`;

                // Add/subtract the reward.
                await Items.add(user.id, 'COOP_POINT', reward, `EGGHUNT_BROKEN_REWARD_${rarity.toUpperCase()}`);
            }
            
            MESSAGES.delayEdit(msg, acknowledgementMsgText, 0);
            REACTIONS.removeAll(msg);

        } catch(e) {
            console.log('Break failed');
            console.error(e);
        }
    };

    static async recordBreak(rarity) {
        return EconomyNotifications.add('EGG_HUNT', {
            type: 'BROKEN',
            eggType: rarity
        });
    }

    static async drop(rarity, dropText = null) {
        const dropChannel = CHANNELS._randomSpammable();
        
        if (dropChannel) {
            try {
                // Make egg messages clear up/temporary to avoid caching issues and improve challenge.
                const eggText = MESSAGES.emojiText(EGG_DATA[rarity].emoji);
                const eggMsg = await MESSAGES.selfDestruct(dropChannel, eggText, 0, (60 * 5) * 1000);

                // Add collection action emoji.
                MESSAGES.delayReact(eggMsg, RAW_EMOJIS.BASKET, STATE.CHANCE.integer({ min: 0, max: 50 }));
                MESSAGES.delayReact(eggMsg, RAW_EMOJIS.HAMMER, STATE.CHANCE.integer({ min: 25, max: 50 }));
                MESSAGES.delayReact(eggMsg, RAW_EMOJIS.BOMB, 100);

                // If TOXIC_EGG add a frying pan emoji
                if (rarity === 'TOXIC_EGG')
                    MESSAGES.delayReact(eggMsg, EMOJIS.FRYING_PAN, 150);

                // If an annotation for the egg drop was provided, use it.
                const fivePercentRoll = STATE.CHANCE.bool({ likelihood: 7.5 });
                if (dropText && fivePercentRoll && dropChannel.id !== CHANNELS_CONFIG.TALK.id)
                    CHANNELS._send('TALK', dropText);

            } catch(e) {
                console.error(e);
            }
        }
    };

    static async dmDrop(rarity) {
        try {
            const randomMember = await USERS.random();
            if (randomMember) {
                // Send via DM.
                const eggMsg = await randomMember.send(MESSAGES.emojiText(EGG_DATA[rarity].emoji));
                MESSAGES.delayReact(eggMsg, RAW_EMOJIS.BASKET, 333);
    
                // Remove toxic egg after 5 minutes so people aren't forced to take it.
                // if (rarity === 'TOXIC_EGG') MESSAGES.delayDelete(eggMsg, 300000);
    
                // Provide feedback.
                let dropText = `${randomMember.user.username} was sent an egg via DM! ${MESSAGES.emojiText(EGG_DATA[rarity].emoji)}`;
                if (rarity === 'LEGENDARY_EGG') dropText = 'OooOoOoOoooo... ' + dropText;
                CHANNELS._postToChannelCode('TALK', dropText);
            }
        } catch(e) {
            console.error(e);
            console.log('Tried to drop an egg in DMs ^');
        }
    };

    static async run() {        
        if (STATE.CHANCE.bool({ likelihood: 80 }))
            this.drop('AVERAGE_EGG', 'Whoops! I dropped an egg,');

        if (STATE.CHANCE.bool({ likelihood: 20 }))
            this.drop('TOXIC_EGG', 'I dropped an egg...');

        if (STATE.CHANCE.bool({ likelihood: 7 }))
            this.drop('RARE_EGG', 'Funknes! Rare egg on the loose!');

        if (STATE.CHANCE.bool({ likelihood: .15 })) {
            CHANNELS._postToChannelCode('TALK', ROLES._textRef('MINIGAME_PING') + ', a legendary egg was dropped! Grab it before others can!');
            this.drop('LEGENDARY_EGG');
        }

        // Small chance of rolling for a direct message egg.
        // if (STATE.CHANCE.bool({ likelihood: 10 })) {
        //     if (STATE.CHANCE.bool({ likelihood: 3.85 })) this.dmDrop('AVERAGE_EGG');
        //     if (STATE.CHANCE.bool({ likelihood: 2.45 })) this.dmDrop('RARE_EGG');
        //     if (STATE.CHANCE.bool({ likelihood: 0.025 })) this.dmDrop('LEGENDARY_EGG');
        // }

        // Small chance of bonus eggs being released.     
        if (STATE.CHANCE.bool({ likelihood: 3.5 })) {        
            const bonusEggRolePing = ROLES._textRef('MINIGAME_PING');
            let bonusEggStatus = ' bonus eggs rolling!';

            // Calculate a number of bonus eggs.
            let bonusEggsNum = STATE.CHANCE.natural({ min: 8, max: 40 });

            // Even rare chance of mass release.
            if (STATE.CHANCE.bool({ likelihood: 1.5 })) {
                bonusEggsNum = STATE.CHANCE.natural({ min: 30, max: 88 });
                bonusEggStatus = ' bonus eggs hurtling!';
            }
            
            // Even rare(er) chance of mass(er) release.
            if (STATE.CHANCE.bool({ likelihood: .075 })) {
                bonusEggsNum = STATE.CHANCE.natural({ min: 50, max: 150 });
                bonusEggStatus = ' bonus eggs bonusing!';
            }

            // Append search text
            bonusEggStatus += ' Search the channels for the eggs!'

            // Announce bonus eggs socially.
            const bannerMsg = await CHANNELS._send('TALK', 'https://cdn.discordapp.com/attachments/723660447508725806/1066971754725126174/bonus-eggs.png');
            const infoMsg = await CHANNELS._send('TALK', bonusEggRolePing + bonusEggStatus, 0, {});

            TemporaryMessages.add(bannerMsg, 30 * 60);
            TemporaryMessages.add(infoMsg, 30 * 60);

            // TODO: Add guide information button

            // Drop the bonus average eggs.
            for (let i = 0; i < bonusEggsNum; i++) {
                setTimeout(() => this.drop('AVERAGE_EGG', null), i * 444);
            }

            // Add in a mixture of toxic eggs.
            const toxicEggsMixupNum = STATE.CHANCE.natural({ min: 3, max: Math.floor(bonusEggsNum / 1.5) });
            for (let i = 0; i < toxicEggsMixupNum; i++) {
                setTimeout(() => this.drop('TOXIC_EGG', null), i * 444);
            }
        }
    }

    static async antiTroll(msg) {
        // Check if message is egg hunt drop but not Cooper.
        const isUserMessage = !USERS.isCooperMsg(msg);
        const isEgghuntDrop = this.isEgghuntDrop(msg.content);
        const eggRarity = this.calculateRarityFromMessage(msg);
        const isTrollEgg = isUserMessage && isEgghuntDrop && eggRarity;

        const roll = STATE.CHANCE.bool({ likelihood: 15 });
        if (isTrollEgg && roll) {
            // Check if the user has an egg.
            const hasQty = await Items.hasQty(msg.author.id, eggRarity, 1);
            if (!hasQty) return false;

            // Try to take the egg from the user.
            const didUse = await Useable.use(msg.author.id, eggRarity, 1);
            if (!didUse) return false;

            await Items.add(STATE.CLIENT.user.id, eggRarity, 1, 'EGGHUNT_ANTITROLL_TAKEN - Stolen trolling egg, karma');
            
            MESSAGES.selfDestruct(msg, 'Thanks for the egg! ;)', 0, 900);
            
            CHANNELS.propagate(msg, 'Cooper collected (stole) an egg.', 'ACTIONS', true);

            MESSAGES.delayReact(msg, RAW_EMOJIS.BASKET, 333);

            MESSAGES.delayDelete(msg, 0);
        }

        
    }
}
