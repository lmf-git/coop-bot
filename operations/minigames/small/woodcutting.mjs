import EconomyNotifications from "../../activity/information/economyNotifications.mjs";

import SkillsHelper from "../medium/skills/skillsHelper.mjs";

import { STATE, REACTIONS, USABLE, ITEMS, MESSAGES, USERS, CHANNELS, ROLES } from "../../../coop.mjs";
import { EMOJIS } from "coop-shared/config.mjs";
import Statistics from "../../activity/information/statistics.mjs";
import TemporaryMessages from "../../activity/maintenance/temporaryMessages.mjs";
import Items from "coop-shared/services/items.mjs";
import Useable from "coop-shared/services/useable.mjs";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export default class WoodcuttingMinigame {

    // Reaction interceptor to check if user is attempting to interact.
    static async onInteract(interaction) {
        const { message, channel, user } = interaction;

        // High chance of preventing any Woodcutting at all to deal with rate limiting.
        if (STATE.CHANCE.bool({ likelihood: 50 })) return false;

        // Woodcutting minigame guards.
        const isOnlyEmojis = MESSAGES.isOnlyEmojisOrIDs(message.content);
        const isCooperMsg = USERS.isCooperMsg(message);
        if (!isCooperMsg) return false;
        if (!isOnlyEmojis) return false;
        
        // Check this character is wood emoji and from cooper.
        const msgContent = message.content;
        const firstEmojiString = (msgContent[0] || '') + (msgContent[1] || '');
        const firstEmojiUni = MESSAGES.emojiToUni(firstEmojiString);
        const rockEmojiUni = MESSAGES.emojiToUni(EMOJIS.WOOD);
        const isWoodMsg = firstEmojiUni === rockEmojiUni;
        if (!isWoodMsg) return false;

        // Allow user to cut the wood.
        this.cut(message, channel, user, interaction);
    };

    // TODO: Broken axe should go in the interaction response?
    static async cut(msg, channel, user, interaction) {
        // Do this in mining also!
        // Check for an existing update message to append to!

        // Calculate multiplier from message: more rocks, greater reward.
        const textMagnitude = MESSAGES.countAllEmojiCodes(msg.content);
        const rewardRemaining = STATE.CHANCE.natural({ min: 1, max: textMagnitude * 4 });

        // Check if has a axe
        const userAxesNum = await Items.getUserItemQty(user.id, 'AXE');
        const noText = `${user.username} tried to cut wood, but doesn't have an axe.`;
        if (userAxesNum <= 0) {
            await interaction.reply({ content: noText, ephemeral: true });
            return MESSAGES.silentSelfDestruct(msg, noText, 0, 3333);
        }

        // Check for existing update message.
        let updateMsg = await MESSAGES.getSimilarExistingMsg(channel, '**WOODCUTTING IN PROGRESS**');

        // Calculate number of extracted wood with applied collab buff/modifier.
        const numCutters = REACTIONS.countType(msg, '🪓') - 1;
        const extractedWoodNum = Math.max(0, Math.ceil(rewardRemaining / 1.25) * numCutters);

        // Clamp lower and upper boundary for chance of pickaxe breaking
        const axeBreakPerc = Math.min(15, Math.max(15, extractedWoodNum));

        const didBreak = STATE.CHANCE.bool({ likelihood: axeBreakPerc });
        if (didBreak) {
            const axeUpdate = await Useable.use(user.id, 'AXE', 1);
            if (axeUpdate) {
                const brokenDamage = -2;
                const pointsDamageResult = await Items.subtract(user.id, 'COOP_POINT', Math.abs(brokenDamage), 'Broken axe damage');
                const ptsDmgText = ITEMS.displayQty(pointsDamageResult);

                // Update economy statistics.
                EconomyNotifications.add('WOODCUTTING', {
                    playerID: user.id,
                    username: user.username,
                    brokenAxes: 1,
                    pointGain: brokenDamage
                });

                // Add the experience.
                SkillsHelper.addXP(user.id, 'woodcutting', 2);
                
                const actionText = `${user.username} broke an axe trying to cut wood, ${userAxesNum - 1} remaining!`;
                const damageText = `${brokenDamage} points (${ptsDmgText}) but gained 2xp in woodcutting for trying.`;

                if (!updateMsg)
                    MESSAGES.silentSelfDestruct(msg, `${actionText} ${damageText}`, 0, 10000);
                else 
                    updateMsg.edit(updateMsg.content + '\n' + `${actionText} ${damageText}`);

                // Remove axe reaction
                // MESSAGES.delayReactionRemoveUser(reaction, user.id, 111);
            }
        } else {
            // See if updating the item returns the item and quantity.
            const addedWood = await Items.add(user.id, 'WOOD', extractedWoodNum, 'Woodcutting');
            const addPoints = await Items.add(user.id, 'COOP_POINT', 1, 'Woodcutting');

            // Rare events from woodcutting.
            if (STATE.CHANCE.bool({ likelihood: 3.33 })) {
                const addDiamond = await Items.add(user.id, 'AVERAGE_EGG', 1, 'Woodcutting uncommon event');
                CHANNELS.propagate(msg, `${user.username} catches an average egg as it falls from a tree! (${addDiamond})`, 'ACTIONS');
            }
            
            // Rarer events from woodcutting.
            if (STATE.CHANCE.bool({ likelihood: 0.25 })) {
                const branchQty = STATE.CHANCE.natural({ min: 5, max: 25 });
                await Items.add(user.id, 'RARE_EGG', branchQty, 'Woodcutting rare event');
                CHANNELS.propagate(msg, `${user.username} triggered a chain branch reaction, ${branchQty} rare eggs found!`, 'ACTIONS');
            }

            // Rarest events from woodcutting.
            if (STATE.CHANCE.bool({ likelihood: 0.0525 })) {
                const legendaryNestQty = STATE.CHANCE.natural({ min: 2, max: 4 });
                await Items.add(user.id, 'LEGENDARY_EGG', legendaryNestQty, 'Woodcutting, very rare event');
                CHANNELS.propagate(msg, `${user.username} hit a lucky branch, ${legendaryNestQty} legendary egg(s) found!`, 'TALK');
            }

            // Reduce the number of rocks in the message.
            if (textMagnitude > 1) await msg.edit(EMOJIS.WOOD.repeat(textMagnitude - 1));
            else await msg.delete();
            
            // Provide feedback.
            const ptsEmoji = MESSAGES.emojiCodeText('COOP_POINT');
            const actionText = `${user.username} +${addedWood}${EMOJIS.WOOD} +${addPoints}${ptsEmoji}`;

            // Either update message or create a new one.
            CHANNELS.propagate(msg, `${actionText}`, 'ACTIONS');

            // Edit and update the message if found
            if (updateMsg) {
                // Update the matching line.
                let matchingAction = false;
                const updatedContent = updateMsg.content.split('\n').map(l => {
                    const regex = new RegExp(`\\b${user.username}\\b \\+(\\d+)${EMOJIS.WOOD} \\+(\\d+)${ptsEmoji}`, 'i');
                    const match = l.match(regex);

                    if (match) {
                        // Parse existing values from the text.
                        const wood = parseInt(match[1], 10);
                        const pts = parseInt(match[2], 10);

                        // Need to know if there is a match to prevent new line being added.
                        matchingAction = true;

                        // Update the line with new wood and coop points
                        return `${user.username} +${wood + addedWood}${EMOJIS.WOOD} +${pts + addPoints}${ptsEmoji}`;
                    }

                    // Return the original line if no match
                    return l;
                }).join('\n');

                // Edit the message with updated content
                if (matchingAction)
                    updateMsg.edit(updatedContent);

                // Add woodcut stats with no matching existing row.
                else
                    updateMsg.edit(updateMsg.content + '\n' + `${actionText}`);
            }
            
            // Store to track latest woodcutting stats.
            EconomyNotifications.add('WOODCUTTING', {
                pointGain: 1,
                recWood: addedWood,
                playerID: user.id,
                username: user.username
            });

            // Add the experience.
            SkillsHelper.addXP(user.id, 'woodcutting', 1);
        }
    }

    static async run() {
        try {
            const base = Math.max(1, await Statistics.calcCommunityVelocity());

            let multiplier = STATE.CHANCE.natural({ min: base, max: base * 5 });
    
            if (STATE.CHANCE.bool({ likelihood: 5 }))
                multiplier = STATE.CHANCE.natural({ min: base * 5, max: base * 20 });
    
            if (STATE.CHANCE.bool({ likelihood: 1 }))
                multiplier = STATE.CHANCE.natural({ min: base * 7, max: base * 35 });
    
            // Calculate the random channel to drop wood in.
            const eventChannel = CHANNELS._randomSpammable();

            // Send the promotion and notification image first, with the stats table.
            const announcementMsg = await eventChannel.send('*Woodcutting needs image here');
            const updatesMsg = await eventChannel.send('🪓 **WOODCUTTING IN PROGRESS** 🪓');

            // Send the wood to cut with the chop action.
            const woodMsg = await eventChannel.send(EMOJIS.WOOD.repeat(multiplier));
            woodMsg.edit({ 
                components: [
                    new ActionRowBuilder().addComponents([
                        new ButtonBuilder()
                            .setEmoji('🪓')
                            .setLabel("Chop")
                            .setCustomId('chop')
                            .setStyle(ButtonStyle.Primary)
                    ])
                ]
            });

            // TODO: Count as ungathered wood in activity messages (when cleaning up)
            TemporaryMessages.add(announcementMsg, 30 * 60);
            TemporaryMessages.add(updatesMsg, 30 * 60);
            TemporaryMessages.add(woodMsg, 30 * 60);

            // Post a message for collecting events against.
            // const branchText = multiplier > 1 ? `${multiplier} branches` : `a branch`;
            // const woodcuttingEventText = `${'Ooo'.repeat(Math.floor(multiplier))} ${ROLES._textRef('MINIGAME_PING')}, a tree with ${branchText} to fell!`;
            // CHANNELS._send('TALK', woodcuttingEventText, {});

        } catch(e) {
            console.log('above error occurred trying to start woodcutting minigame');
        }
    }
}
