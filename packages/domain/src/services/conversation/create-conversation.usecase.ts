import { ConversationEntity, Conversation } from '../../entities';
import { IConversationRepository } from '../../repositories';
import {
  CreateConversationUseCase,
  ConversationOutput,
  CreateConversationInput,
} from '../../usecases';

export class CreateConversationService implements CreateConversationUseCase {
  constructor(
    private readonly conversationRepository: IConversationRepository,
  ) {}

  public async execute(
    conversationDTO: CreateConversationInput,
  ): Promise<ConversationOutput> {
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'create-conversation.usecase.ts:14','message':'CreateConversationService.execute - input',data:{conversationDTO,createdBy:conversationDTO.createdBy,createdByType:typeof conversationDTO.createdBy},timestamp:Date.now(),runId:'run1',hypothesisId:'A,C,D'})}).catch(()=>{});
    // #endregion
    const newConversation = ConversationEntity.create(conversationDTO);
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'create-conversation.usecase.ts:17','message':'CreateConversationService.execute - entity created',data:{newConversationId:newConversation.id,newConversationCreatedBy:newConversation.createdBy,newConversationUpdatedBy:newConversation.updatedBy},timestamp:Date.now(),runId:'run1',hypothesisId:'A,E'})}).catch(()=>{});
    // #endregion

    const conversation = await this.conversationRepository.create(
      newConversation as unknown as Conversation,
    );
    return ConversationOutput.new(conversation);
  }
}
