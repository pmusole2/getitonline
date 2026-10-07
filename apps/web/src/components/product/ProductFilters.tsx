"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { X, SlidersHorizontal } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { CONDITION_DISPLAY_NAMES, ZAMBIAN_PROVINCES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";

export interface FilterState {
  conditions: string[];
  priceMin: number;
  priceMax: number;
  province: string;
  sortBy: string;
}

interface ProductFiltersProps {
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  maxPrice?: number;
}

const conditions = Object.entries(CONDITION_DISPLAY_NAMES).map(
  ([value, label]) => ({
    value,
    label,
  })
);

const sortOptions = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "price_low", label: "Price: Low to High" },
  { value: "price_high", label: "Price: High to Low" },
  { value: "popular", label: "Most Popular" },
];

function FilterContent({
  filters,
  onFiltersChange,
  maxPrice = 100000,
}: ProductFiltersProps) {
  const handleConditionChange = (condition: string, checked: boolean) => {
    const newConditions = checked
      ? [...filters.conditions, condition]
      : filters.conditions.filter((c) => c !== condition);
    onFiltersChange({ ...filters, conditions: newConditions });
  };

  const handlePriceChange = (values: number[]) => {
    onFiltersChange({
      ...filters,
      priceMin: values[0],
      priceMax: values[1],
    });
  };

  const clearFilters = () => {
    onFiltersChange({
      conditions: [],
      priceMin: 0,
      priceMax: maxPrice,
      province: "",
      sortBy: "newest",
    });
  };

  const activeFiltersCount =
    filters.conditions.length +
    (filters.priceMin > 0 ? 1 : 0) +
    (filters.priceMax < maxPrice ? 1 : 0) +
    (filters.province ? 1 : 0);

  return (
    <div className="space-y-6">
      {/* Active Filters */}
      {activeFiltersCount > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Active filters:</span>
          {filters.conditions.map((condition) => (
            <Badge
              key={condition}
              variant="secondary"
              className="cursor-pointer"
              onClick={() => handleConditionChange(condition, false)}
            >
              {CONDITION_DISPLAY_NAMES[condition]}
              <X className="ml-1 h-3 w-3" />
            </Badge>
          ))}
          {filters.province && (
            <Badge
              variant="secondary"
              className="cursor-pointer"
              onClick={() => onFiltersChange({ ...filters, province: "" })}
            >
              {filters.province}
              <X className="ml-1 h-3 w-3" />
            </Badge>
          )}
          {(filters.priceMin > 0 || filters.priceMax < maxPrice) && (
            <Badge
              variant="secondary"
              className="cursor-pointer"
              onClick={() =>
                onFiltersChange({ ...filters, priceMin: 0, priceMax: maxPrice })
              }
            >
              {formatZMW(filters.priceMin)} - {formatZMW(filters.priceMax)}
              <X className="ml-1 h-3 w-3" />
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear all
          </Button>
        </div>
      )}

      <Accordion
        type="multiple"
        defaultValue={["condition", "price", "location"]}
        className="w-full"
      >
        {/* Condition Filter */}
        <AccordionItem value="condition">
          <AccordionTrigger>Condition</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-3">
              {conditions.map((condition) => (
                <div key={condition.value} className="flex items-center gap-2">
                  <Checkbox
                    id={`condition-${condition.value}`}
                    checked={filters.conditions.includes(condition.value)}
                    onCheckedChange={(checked) =>
                      handleConditionChange(condition.value, checked as boolean)
                    }
                  />
                  <Label
                    htmlFor={`condition-${condition.value}`}
                    className="cursor-pointer"
                  >
                    {condition.label}
                  </Label>
                </div>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Price Filter */}
        <AccordionItem value="price">
          <AccordionTrigger>Price Range</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4">
              <Slider
                min={0}
                max={maxPrice}
                step={100}
                value={[filters.priceMin, filters.priceMax]}
                onValueChange={handlePriceChange}
                className="py-4"
              />
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Label htmlFor="minPrice" className="text-xs">
                    Min
                  </Label>
                  <Input
                    id="minPrice"
                    type="number"
                    value={filters.priceMin}
                    onChange={(e) =>
                      onFiltersChange({
                        ...filters,
                        priceMin: Number(e.target.value),
                      })
                    }
                    className="h-8"
                  />
                </div>
                <span className="mt-5">-</span>
                <div className="flex-1">
                  <Label htmlFor="maxPrice" className="text-xs">
                    Max
                  </Label>
                  <Input
                    id="maxPrice"
                    type="number"
                    value={filters.priceMax}
                    onChange={(e) =>
                      onFiltersChange({
                        ...filters,
                        priceMax: Number(e.target.value),
                      })
                    }
                    className="h-8"
                  />
                </div>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Location Filter */}
        <AccordionItem value="location">
          <AccordionTrigger>Location</AccordionTrigger>
          <AccordionContent>
            <Select
              value={filters.province || "all"}
              onValueChange={(value) =>
                onFiltersChange({
                  ...filters,
                  province: value === "all" ? "" : value,
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select province" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Provinces</SelectItem>
                {ZAMBIAN_PROVINCES.map((province) => (
                  <SelectItem key={province} value={province}>
                    {province}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

export function ProductFilters(props: ProductFiltersProps) {
  return (
    <>
      {/* Desktop Filters */}
      <div className="hidden lg:block">
        <FilterContent {...props} />
      </div>

      {/* Mobile Filters */}
      <div className="lg:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" className="gap-2">
              <SlidersHorizontal className="h-4 w-4" />
              Filters
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-80">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="mt-6">
              <FilterContent {...props} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}

export function ProductSortSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[180px]">
        <SelectValue placeholder="Sort by" />
      </SelectTrigger>
      <SelectContent>
        {sortOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
