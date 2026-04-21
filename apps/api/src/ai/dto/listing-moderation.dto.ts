import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class ModerateListingDto {
  @ApiProperty({ description: 'Reviewer user id from Convex' })
  @IsString()
  reviewerId: string;

  @ApiProperty({ description: 'Product id from Convex' })
  @IsString()
  productId: string;

  @ApiProperty({ description: 'Listing title' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Listing description' })
  @IsString()
  description: string;

  @ApiProperty({ description: 'Listing price in ZMW' })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ description: 'Listing quantity' })
  @IsNumber()
  @Min(0)
  quantity: number;

  @ApiProperty({ description: 'Uploaded image URLs', type: [String] })
  @IsArray()
  @IsString({ each: true })
  imageUrls: string[];

  @ApiProperty({ description: 'Category display name', required: false })
  @IsOptional()
  @IsString()
  categoryName?: string;
}

export class ListingModerationResponseDto {
  @ApiProperty({ enum: ['clear', 'flagged', 'error'] })
  status: 'clear' | 'flagged' | 'error';

  @ApiProperty()
  summary: string;

  @ApiProperty({ type: [String] })
  flags: string[];
}
