import { Module, forwardRef } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { RecommendationsService } from './services/recommendations.service';
import { MessageRephraseService } from './services/message-rephrase.service';
import { DisputeAnalysisService } from './services/dispute-analysis.service';
import { ChatService } from './services/chat.service';
import { ListingModerationService } from './services/listing-moderation.service';
import { ConvexModule } from '../convex/convex.module';

@Module({
  imports: [ConvexModule],
  controllers: [AiController],
  providers: [
    AiService,
    RecommendationsService,
    MessageRephraseService,
    DisputeAnalysisService,
    ChatService,
    ListingModerationService,
  ],
  exports: [
    AiService,
    RecommendationsService,
    MessageRephraseService,
    DisputeAnalysisService,
    ChatService,
    ListingModerationService,
  ],
})
export class AiModule {}
