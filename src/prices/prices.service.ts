import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan } from 'typeorm';
import { Price } from './price.entity';
import { Alert } from './alert.entity';
import { EmailService } from '../email/email.service';
import { Cron } from '@nestjs/schedule';
import Moralis from 'moralis';
import * as process from 'node:process';

@Injectable()
export class PriceService implements OnModuleInit {
    private readonly logger = new Logger(PriceService.name);

    constructor(
        @InjectRepository(Price) private readonly priceRepository: Repository<Price>,
        @InjectRepository(Alert) private readonly alertRepository: Repository<Alert>,
        private readonly emailService: EmailService,
    ) {}

    async onModuleInit() {
        try {
            await Moralis.start({ apiKey: process.env.MORALIS_API_KEY });
            this.logger.log('Moralis API initialized.');
        } catch (error) {
            this.logger.error('Error initializing Moralis API', error);
        }
    }

    @Cron('* * * * *')
    async fetchPrices() {
        try {
            const chains = process.env.CHAINS?.split(',').map(chain => chain.trim()) ?? [];
            const blockChainData = await this.fetchBlockChainData();

            await Promise.all(
                chains.map(async chain => {
                    const chainData = blockChainData.find(item => item.name.toLowerCase() === chain.toLowerCase());
                    if (chainData) {
                        await this.savePrice(chain, chainData.usd_price);
                        await this.checkPriceIncrease(chain, chainData.usd_price);
                        await this.checkPriceAlert(chain, chainData.usd_price);
                    } else {
                        this.logger.error(`Data for chain '${chain}' not found.`);
                    }
                }),
            );

            this.logger.log('Prices fetched and processed successfully.');
        } catch (error) {
            this.logger.error('Error fetching and processing prices', error);
        }
    }

    private async fetchBlockChainData(): Promise<any> {
        try {
            return (await Moralis.EvmApi.marketData.getTopCryptoCurrenciesByMarketCap()).raw;
        } catch (error) {
            this.logger.error('Error fetching blockchain data', error);
            throw new Error('Failed to fetch blockchain data');
        }
    }

    private async savePrice(chain: string, price: number) {
        try {
            const newPrice = this.priceRepository.create({ chain, price });
            await this.priceRepository.save(newPrice);
            this.logger.log(`Saved ${chain} price: ${price}`);
        } catch (error) {
            this.logger.error(`Error saving price for chain ${chain}`, error);
        }
    }

    private async checkPriceIncrease(chain: string, currentPrice: number) {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        try {
            const priceOneHourAgo = await this.priceRepository.findOne({
                where: { chain, createdAt: LessThan(oneHourAgo) },
                order: { createdAt: 'DESC' },
            });

            if (priceOneHourAgo) {
                const priceIncrease = ((currentPrice - priceOneHourAgo.price) / priceOneHourAgo.price) * 100;
                if (priceIncrease > 3) {
                    await this.emailService.sendEmail(
                        process.env.ADMIN_EMAIL,
                        `${chain} Price Alert: 3% Increase`,
                        `${chain} price increased by ${priceIncrease.toFixed(2)}% in the past hour. Current price: $${currentPrice}`,
                    );
                }
            }
        } catch (error) {
            this.logger.error(`Error checking price increase for chain ${chain}`, error);
        }
    }

    private async checkPriceAlert(chain: string, price: number) {
        try {
            const alerts = await this.alertRepository.find({ where: { chain } });

            await Promise.all(
                alerts.map(alert => {
                    if (price >= alert.targetPrice) {
                        return this.emailService.sendEmail(
                            alert.email,
                            `${chain} Price Alert`,
                            `${chain} has reached the target price of $${alert.targetPrice}`,
                        );
                    }
                }),
            );
        } catch (error) {
            this.logger.error(`Error checking price alerts for chain ${chain}`, error);
        }
    }

    async getHourlyPrices(): Promise<{ chain: string; hourlyPrices: any[] }[]> {
        const chains = process.env.CHAINS?.split(',').map(chain => chain.trim()) ?? [];
        return Promise.all(
            chains.map(async chain => {
                const hourlyPrices = await this.getHourlyChainPrices(chain);
                return { chain, hourlyPrices };
            }),
        );
    }

    private async getHourlyChainPrices(chain: string): Promise<{ hour: number; averagePrice: number }[]> {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        try {
            const prices = await this.priceRepository.find({
                where: { chain, createdAt: MoreThan(twentyFourHoursAgo) },
                order: { createdAt: 'ASC' },
            });

            const hourlyPricesMap = prices.reduce((acc, price) => {
                const hour = price.createdAt.getHours();
                acc[hour] = acc[hour] || [];
                acc[hour].push(Number(price.price));
                return acc;
            }, {} as Record<number, number[]>);

            return Object.entries(hourlyPricesMap).map(([hour, prices]) => {
                const averagePrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
                return { hour: Number(hour), averagePrice: parseFloat(averagePrice.toFixed(2)) };
            });
        } catch (error) {
            this.logger.error(`Error getting hourly prices for chain ${chain}`, error);
            return [];
        }
    }

    async setAlert(chain: string, targetPrice: number, email: string): Promise<void> {
        try {
            const alert = await this.alertRepository.findOne({ where: { chain, email } });

            if (alert) {
                alert.targetPrice = targetPrice;
                await this.alertRepository.save(alert);
            } else {
                const newAlert = this.alertRepository.create({ chain, targetPrice, email });
                await this.alertRepository.save(newAlert);
            }
        } catch (error) {
            this.logger.error(`Error setting alert for chain ${chain}`, error);
        }
    }
}
