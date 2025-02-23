import { CHANNELS, MESSAGES, USERS, INTERACTION } from '../../../coop.mjs';
import DropTable from '../medium/economy/items/droptable.mjs';
import TemporaryMessages from '../../activity/maintenance/temporaryMessages.mjs';
import ItemsShared from "coop-shared/services/items.mjs";
import Trading from "coop-shared/services/trading.mjs";

export default class DailyRewardMinigame {
    

    // Safeguard: Check if the user can claim rewards (24h cooldown)
    static async allowClaimDate(lastClaim) {
        // If the date is NULL (default in database), then can claim
        if (!lastClaim) return true;

        // Invalid date format safeguard
        if (isNaN(Date.parse(lastClaim))) return false;

        // Check if 24 hours have passed since the last claim
        const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
        return new Date(lastClaim).getTime() <= twentyFourHoursAgo;
    }

    // Safeguard: Check if the user has too many of the item
    static async hasUserOverItemLimit(userId, item) {
        // Check if user has 7 or more of the specified item
        return await ItemsShared.hasQty(userId, item, 7);
    }

    // Safeguard: Check if the user has an open trade for the same item
    static async hasOpenTradeForItem(userId, item) {
        const openTrades = await Trading.getByTrader(userId);
        return openTrades.some(trade => trade.offer_item === item);
    }

    // onInteraction handler for Daily Reward Button (created in chicken.mjs)
    static async onInteraction(interaction) {
        // Only run the button for claim_daily_reward
        if (interaction.customId !== "claim_daily_reward") return false;

        try {
            const userId = interaction.user.id;
            // Fetch the last claim date for user
            const lastClaim = await USERS.getUserLastClaim(userId);
            // Safeguard claim date
            if(!(await this.allowClaimDate(lastClaim.last_claim))) 
                // TODO: Reply could contain hours/mins until next claim
                return await INTERACTION.reply(interaction, `Daily reward is on cooldown, try again later!`);

            // Update the userLastClaim date
            await USERS.setUserLastClaim(userId)

            // Get one reward from droptable for Gathering drops
            const item = DropTable.getRandomTiered('GATHERING');
            // Safeguard item quantity (if user has equal or over 7, dont reward)
            if (await this.hasUserOverItemLimit(userId, item)) 
                return await INTERACTION.reply(interaction, `You already have the maximum amount of daily reward items!`);

            // Safeguard trading bypass (if user has outstanding trade with the itemtype, dont reward)
            if (await this.hasOpenTradeForItem(userId, item)) 
                return await INTERACTION.reply(interaction, `You have an outstanding trade with the daily reward item.`);

            // Announce the rewards in TALK
            const dailyRewardText = `<@${userId}> collected the daily reward: ${MESSAGES.emojiCodeText(item)}`;
            const dailyRewardMessage = await CHANNELS._send('TALK', dailyRewardText);
            TemporaryMessages.add(dailyRewardMessage, 30 * 60);

            // Reward user with the item
            ItemsShared.add(interaction.user.id, item, 1, `Daily reward`);
            return await INTERACTION.reply(interaction, `You claimed your daily reward! 🐔`);

        } catch (e) {
            console.error(e);
            console.log('Error while giving Daily Rewards');
        }
    };
};
