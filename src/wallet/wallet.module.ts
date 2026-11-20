import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module.js';
import { DepositsController } from './deposits.controller.js';
import { DepositsService } from './deposits.service.js';
import { HoldsController } from './holds.controller.js';
import { HoldsService } from './holds.service.js';
import { TransfersController } from './transfers.controller.js';
import { TransfersService } from './transfers.service.js';
import { WalletsController } from './wallets.controller.js';
import { WalletsService } from './wallets.service.js';

@Module({
  imports: [LedgerModule],
  controllers: [WalletsController, DepositsController, HoldsController, TransfersController],
  providers: [WalletsService, DepositsService, HoldsService, TransfersService],
  exports: [WalletsService, DepositsService, HoldsService, TransfersService],
})
export class WalletModule {}
