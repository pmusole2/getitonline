import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class VisualSearchDto {
  @ApiProperty({ description: 'JPEG data URL for the captured search image' })
  @IsString()
  @MaxLength(500_000)
  imageDataUrl: string;
}

export class VisualSearchResponseDto {
  @ApiProperty({ description: 'Search query generated from the image' })
  query: string;

  @ApiProperty({ description: 'Detected product search terms', type: [String] })
  terms: string[];
}
